// voice-model.js (v2) — record real audio with MediaRecorder, then transcribe it
// ON-DEVICE with a small Whisper model (transformers.js). This is the path used
// on iPhone/iPad, where the browser SpeechRecognition API doesn't work. It needs
// a one-time model download (~40MB, cached by the browser afterwards) and runs
// entirely in the page — no server, no key.
//
// getUserMedia + MediaRecorder work on iOS Safari (14.3+); the model download +
// inference are lazy (only when the learner first records on a device that needs
// this path), so desktop and initial page load stay light.

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const MODEL_ID = "Xenova/whisper-tiny"; // multilingual; smallest usable Whisper

let tfModulePromise = null;
function tf() {
  if (!tfModulePromise) tfModulePromise = import(/* @vite-ignore */ TRANSFORMERS_CDN);
  return tfModulePromise;
}

let transcriberPromise = null;
async function getTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await tf();
      env.allowLocalModels = false; // fetch from the HF hub CDN
      return pipeline("automatic-speech-recognition", MODEL_ID, {
        quantized: true,
        progress_callback: onProgress,
      });
    })();
  }
  return transcriberPromise;
}

// True when this browser can record audio (the prerequisite for the model path).
export function canRecordAudio() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// Start recording immediately; keep going until stop() is called, then transcribe
// the captured audio on-device. Returns { promise, stop }.
//   onStart(): mic is live (show "Recording…")
//   onStatus(stage, info): 'model' | 'download'(+progress) | 'transcribe'
export function recordAndTranscribe({ onStart, onStatus, lang = "chinese" } = {}) {
  const ctl = { recorder: null, stream: null, stopRequested: false };

  const promise = (async () => {
    ctl.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(ctl.stream); // let the browser pick a supported mime (mp4/aac on iOS)
    ctl.recorder = recorder;
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((res) => {
      recorder.onstop = res;
    });
    recorder.start();
    if (onStart) onStart();
    // If stop() was pressed during mic setup, honour it now.
    if (ctl.stopRequested && recorder.state !== "inactive") recorder.stop();

    await stopped;
    ctl.stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) return "";

    if (onStatus) onStatus("model");
    const transcriber = await getTranscriber((p) => {
      if (p && p.status === "progress" && onStatus) onStatus("download", p);
    });

    if (onStatus) onStatus("transcribe");
    const blob = new Blob(chunks, { type: chunks[0].type || "audio/mp4" });
    const url = URL.createObjectURL(blob);
    try {
      const { read_audio } = await tf();
      const audio = await read_audio(url, 16000); // decode + resample to 16kHz mono
      const out = await transcriber(audio, { language: lang, task: "transcribe" });
      return ((out && out.text) || "").trim();
    } finally {
      URL.revokeObjectURL(url);
    }
  })();

  return {
    promise,
    stop() {
      ctl.stopRequested = true;
      try {
        if (ctl.recorder && ctl.recorder.state !== "inactive") ctl.recorder.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
