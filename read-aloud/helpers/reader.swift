// reader: reads a piece aloud, sentence by sentence, in one continuous audio stream.
//
//   reader <id> <voice> <status file> <rate file> <token file> <token> <start> <sentence>...
//   reader --probe      prints the processes recording from a microphone right now
//
// Sentences are rendered ahead with `say -o` and queued back to back on one player node,
// so there is no restart between them; the silence `say` puts around each sentence is
// trimmed to a short natural pause. The next sentence is queued only just before the
// current one ends, at the rate read from <rate file> then (words per minute), so a speed
// change applies from the next sentence. It stops at once when <token file> no longer
// holds <token> (another reading took over, or Stop) or when any app starts recording.
// After each sentence it writes {"id","index","code"} to <status file>: index is the
// sentence to go on from; code 0 = played, 1 = stopped by recording, 2 = stopped by token;
// "done": true once the last sentence has played.
import AVFoundation
import CoreAudio
import Foundation

// MARK: recording check

func prop<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func recordingPids() -> [pid_t] {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &list) == noErr else { return [] }
  return list.compactMap { process in
    guard prop(process, kAudioProcessPropertyIsRunningInput, UInt32(0)) ?? 0 != 0 else { return nil }
    return prop(process, kAudioProcessPropertyPID, pid_t(0))
  }
}

let args = CommandLine.arguments
if args.count > 1 && args[1] == "--probe" {
  print(recordingPids())
  exit(0)
}
guard args.count >= 8 else { exit(2) }

let id = args[1], voice = args[2], statusPath = args[3], ratePath = args[4]
let tokenPath = args[5], token = args[6]
let start = Int(args[7]) ?? 0
let sentences = Array(args.dropFirst(8))

func readRate() -> Int {
  let text = (try? String(contentsOfFile: ratePath, encoding: .utf8)) ?? ""
  return Int(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 180
}

func ownsPlayback() -> Bool {
  (try? String(contentsOfFile: tokenPath, encoding: .utf8)) == token
}

func writeStatus(_ index: Int, _ code: Int, done: Bool = false) {
  let text = "{\"id\":\"\(id)\",\"index\":\(index),\"code\":\(code)\(done ? ",\"done\":true" : "")}"
  try? text.write(toFile: statusPath, atomically: true, encoding: .utf8)
}

if start >= sentences.count {
  writeStatus(sentences.count, 0, done: true)
  exit(0)
}

// MARK: rendering

let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("read-aloud-\(getpid())")
try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)

// Keeps at most `lead` seconds of silence at the start and `tail` at the end.
func trimmed(_ buffer: AVAudioPCMBuffer, lead: Double = 0.02, tail: Double = 0.12) -> AVAudioPCMBuffer {
  guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return buffer }
  let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
  let rate = buffer.format.sampleRate, threshold: Float = 0.003
  func loud(_ i: Int) -> Bool { (0..<channels).contains { abs(data[$0][i]) > threshold } }
  var first = 0
  while first < frames && !loud(first) { first += 1 }
  var last = frames - 1
  while last > first && !loud(last) { last -= 1 }
  if first >= frames { return buffer }
  let from = max(0, first - Int(lead * rate))
  let to = min(frames, last + 1 + Int(tail * rate))
  guard let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(to - from))
  else { return buffer }
  out.frameLength = AVAudioFrameCount(to - from)
  for c in 0..<channels {
    out.floatChannelData![c].update(from: data[c] + from, count: to - from)
  }
  return out
}

func render(_ index: Int, rate: Int) -> AVAudioPCMBuffer? {
  let url = scratch.appendingPathComponent("\(index)-\(rate).aiff")
  let say = Process()
  say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
  // An empty voice name means the system voice.
  say.arguments = (voice.isEmpty ? [] : ["-v", voice]) + ["-r", String(rate), "-o", url.path, "--", sentences[index]]
  do { try say.run() } catch { return nil }
  say.waitUntilExit()
  defer { try? FileManager.default.removeItem(at: url) }
  guard say.terminationStatus == 0, let file = try? AVAudioFile(forReading: url),
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
  else { return nil }
  do { try file.read(into: buffer) } catch { return nil }
  // The pause after a sentence shrinks with the speed: a breath at 1x, shorter when faster.
  return trimmed(buffer, tail: 0.14 * 180 / Double(max(rate, 60)))
}

// MARK: playback (all state below is touched on the main queue only)

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
var isEngineReady = false

struct Rendered { let rate: Int; let buffer: AVAudioPCMBuffer }
var rendered: [Int: Rendered] = [:]
var inFlight: Set<String> = []
let renderQueue = DispatchQueue(label: "render")

var nextToQueue = start  // the next sentence to put on the player
var playing = start  // the sentence being heard (or about to be)
var queuedFrames: AVAudioFramePosition = 0  // all frames put on the player so far
var sampleRate: Double = 22050

func finish(_ code: Int) -> Never {
  player.stop()
  engine.stop()
  writeStatus(playing, code)
  try? FileManager.default.removeItem(at: scratch)
  exit(0)
}

func requestRender(_ index: Int, rate: Int) {
  guard index < sentences.count else { return }
  if rendered[index]?.rate == rate { return }
  let key = "\(index)-\(rate)"
  guard !inFlight.contains(key) else { return }
  inFlight.insert(key)
  renderQueue.async {
    let buffer = render(index, rate: rate)
    DispatchQueue.main.async {
      inFlight.remove(key)
      if let buffer { rendered[index] = Rendered(rate: rate, buffer: buffer) }
    }
  }
}

func secondsLeftQueued() -> Double {
  guard isEngineReady, let nodeTime = player.lastRenderTime,
    let playerTime = player.playerTime(forNodeTime: nodeTime)
  else { return 0 }
  return Double(queuedFrames - playerTime.sampleTime) / sampleRate
}

func enqueue(_ index: Int) {
  guard let item = rendered[index] else { return }
  if !isEngineReady {
    sampleRate = item.buffer.format.sampleRate
    engine.connect(player, to: engine.mainMixerNode, format: item.buffer.format)
    do { try engine.start() } catch { finish(2) }
    isEngineReady = true
  }
  queuedFrames += AVAudioFramePosition(item.buffer.frameLength)
  player.scheduleBuffer(item.buffer, completionCallbackType: .dataPlayedBack) { _ in
    DispatchQueue.main.async {
      playing = index + 1
      if index + 1 >= sentences.count {
        writeStatus(sentences.count, 0, done: true)
        engine.stop()
        try? FileManager.default.removeItem(at: scratch)
        exit(0)
      }
      writeStatus(index + 1, 0)
    }
  }
  if !player.isPlaying { player.play() }
  rendered[index] = nil
  nextToQueue = index + 1
}

// Every 25 ms: stop when asked or when someone records; keep the next sentence rendered
// at the current rate; queue it just before the current one runs out.
Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { _ in
  if !ownsPlayback() { finish(2) }
  if !recordingPids().isEmpty { finish(1) }
  guard nextToQueue < sentences.count else { return }

  let rate = readRate()
  requestRender(nextToQueue, rate: rate)
  requestRender(nextToQueue + 1, rate: rate)

  guard let ready = rendered[nextToQueue] else { return }
  let left = secondsLeftQueued()
  // Queue at the current rate when there is under a third of a second left; with the
  // right rate not ready yet, keep the stream going with the old one in the last 60 ms.
  if (ready.rate == rate && left < 0.33) || left < 0.06 {
    enqueue(nextToQueue)
  }
}

RunLoop.main.run()
