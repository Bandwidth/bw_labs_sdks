const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  apiKey: $("#api-key"),
  toggleKey: $("#toggle-key"),
  baseUrl: $("#base-url"),
  statusDot: $("#status-dot"),
  statusState: $("#status-state"),
  sessionRequestId: $("#session-request-id"),
  instantStart: $("#instant-start"),
  instantStop: $("#instant-stop"),
  instantTranscript: $("#instant-transcript"),
  instantSegmentCount: $("#instant-segment-count"),
  instantWordCount: $("#instant-word-count"),
  instantWords: $("#instant-words"),
  demandStart: $("#demand-start"),
  demandFinalize: $("#demand-finalize"),
  demandClose: $("#demand-close"),
  demandDeliveries: $("#demand-deliveries"),
  wavFile: $("#wav-file"),
  fileName: $("#file-name"),
  recordTen: $("#record-ten"),
  recordStatus: $("#record-status"),
  transcribeSend: $("#transcribe-send"),
  transcribeResponse: $("#transcribe-response"),
  keywords: $("#keywords"),
  piiEnabled: $("#pii-enabled"),
  piiReturn: $("#pii-return"),
  piiDisabledNote: $("#pii-disabled-note"),
  rawLog: $("#raw-log"),
  rawLogCount: $("#raw-log-count"),
  clearLog: $("#clear-log"),
};

const tabNames = ["instant", "demand", "transcribe"];
const state = {
  activeTab: "instant",
  socket: null,
  mode: null,
  sessionOpen: false,
  closing: false,
  capture: null,
  instantText: "",
  instantSegments: 0,
  instantWords: [],
  selectedAudio: null,
  selectedAudioName: "",
  recording: false,
  recordChunks: [],
  flushWaiter: null,
  rawLogEntries: 0,
  lastBridgeError: false,
};

function setStatus(label, kind = "idle") {
  elements.statusState.textContent = label;
  elements.statusDot.className = `status-dot status-${kind}`;
}

function bridgeIsOpen() {
  return state.socket !== null && state.socket.readyState === WebSocket.OPEN;
}

function bridgeIsActive() {
  return state.socket !== null && state.socket.readyState !== WebSocket.CLOSED;
}

function updateControls() {
  const active = bridgeIsActive();
  const open = state.sessionOpen && bridgeIsOpen();
  const captureBusy = state.capture !== null || state.recording;
  elements.instantStart.disabled = active || captureBusy;
  elements.instantStop.disabled = !active || state.mode !== "instant";
  elements.demandStart.disabled = active || captureBusy;
  elements.demandFinalize.disabled = !open || state.mode !== "demand" || state.closing;
  elements.demandClose.disabled = !active || state.mode !== "demand" || state.closing;
  elements.recordTen.disabled = active || state.recording;
  elements.transcribeSend.disabled = state.selectedAudio === null || state.recording || active;
}

function setActiveTab(name) {
  if (!tabNames.includes(name)) return;
  state.activeTab = name;
  for (const tabName of tabNames) {
    const button = $(`#tab-button-${tabName}`);
    const panel = $(`#tab-${tabName}`);
    const selected = tabName === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    panel.hidden = !selected;
    panel.classList.toggle("hidden", !selected);
  }
  updatePiiAvailability();
}

function updatePiiAvailability() {
  const instant = state.activeTab === "instant";
  const piiEnabled = elements.piiEnabled.checked;
  elements.piiEnabled.disabled = instant;
  for (const control of $$(".pii-control")) control.disabled = instant || !piiEnabled;
  elements.piiDisabledNote.hidden = !instant;
}

function featureOptions(redactionAllowed) {
  const keywords = elements.keywords.value
    .split(",")
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  const options = {};
  if (keywords.length > 0) options.keywords = keywords;
  if (redactionAllowed && elements.piiEnabled.checked) {
    const policies = $$(".policy-checkbox:checked").map((checkbox) => checkbox.value);
    const substitution = $(".substitution-radio:checked")?.value;
    options.redactPii = true;
    if (policies.length > 0) options.redactPiiPolicies = policies;
    if (substitution === "entity_name" || substitution === "hash") options.redactPiiSub = substitution;
    if (elements.piiReturn.checked) options.redactPiiReturn = true;
  }
  return options;
}

function appendRawLog(payload) {
  state.rawLogEntries += 1;
  const line = document.createElement("div");
  line.textContent = `${new Date().toISOString()} ${JSON.stringify(payload)}`;
  elements.rawLog.append(line);
  elements.rawLogCount.textContent = `${state.rawLogEntries} ${state.rawLogEntries === 1 ? "entry" : "entries"}`;
  elements.rawLog.scrollTop = elements.rawLog.scrollHeight;
}

function clearRawLog() {
  elements.rawLog.replaceChildren();
  state.rawLogEntries = 0;
  elements.rawLogCount.textContent = "0 entries";
}

function resetInstantView() {
  state.instantText = "";
  state.instantSegments = 0;
  state.instantWords = [];
  elements.instantTranscript.textContent = "";
  elements.instantSegmentCount.textContent = "0 segments";
  elements.instantWordCount.textContent = "0";
  elements.instantWords.replaceChildren();
}

function appendInstantSegment(segment) {
  state.instantText += segment.text;
  state.instantSegments += 1;
  state.instantWords.push(...(Array.isArray(segment.words) ? segment.words : []));
  elements.instantTranscript.textContent = state.instantText;
  elements.instantSegmentCount.textContent = `${state.instantSegments} ${state.instantSegments === 1 ? "segment" : "segments"}`;
  elements.instantWordCount.textContent = String(state.instantWords.length);
  elements.instantWords.replaceChildren();
  for (const word of state.instantWords) {
    const row = document.createElement("tr");
    appendCell(row, word.word);
    appendCell(row, formatNumber(word.start));
    appendCell(row, formatNumber(word.end));
    elements.instantWords.append(row);
  }
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value === null || value === undefined ? "" : String(value);
  row.append(cell);
}

function appendHeader(row, value) {
  const cell = document.createElement("th");
  cell.scope = "col";
  cell.textContent = value;
  row.append(cell);
}

function makeTable(headers, rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) appendHeader(headRow, header);
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const rowValues of rows) {
    const row = document.createElement("tr");
    for (const value of rowValues) appendCell(row, value);
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toFixed(3);
}

function formatJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function removeDemandEmptyState() {
  elements.demandDeliveries.querySelector(".empty-state")?.remove();
}

function appendDeliveryBlock(title, transcripts) {
  removeDemandEmptyState();
  const block = document.createElement("article");
  block.className = "delivery-block";
  const heading = document.createElement("div");
  heading.className = "delivery-heading";
  const headingTitle = document.createElement("h3");
  headingTitle.textContent = title;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  heading.append(headingTitle, time);
  block.append(heading);

  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "transcript-result";
    empty.textContent = "No Transcript objects were returned.";
    block.append(empty);
  } else {
    for (const transcript of transcripts) block.append(makeTranscriptResult(transcript));
  }
  elements.demandDeliveries.append(block);
}

function makeTranscriptResult(transcript) {
  const result = document.createElement("section");
  result.className = "transcript-result";
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const channel = document.createElement("span");
  channel.textContent = `channel ${transcript.channel ?? "?"}`;
  const wordCount = document.createElement("span");
  wordCount.textContent = `${Array.isArray(transcript.words) ? transcript.words.length : 0} words`;
  const redaction = transcript.redaction ?? {};
  const redactionSummary = document.createElement("span");
  const policyText = Array.isArray(redaction.policies) && redaction.policies.length > 0
    ? `: ${redaction.policies.join(", ")}`
    : "";
  redactionSummary.textContent = `redaction ${redaction.applied ? "applied" : "off"}${policyText} (${redaction.entitiesRedacted ?? 0} entities)`;
  meta.append(channel, wordCount, redactionSummary);
  result.append(meta);

  const text = document.createElement("p");
  text.className = "result-text";
  text.textContent = transcript.text ?? "";
  result.append(text);

  if (Array.isArray(transcript.redactedEntities)) {
    const entityTitle = document.createElement("div");
    entityTitle.className = "label-small entity-table";
    entityTitle.textContent = `Redacted entities (${transcript.redactedEntities.length})`;
    result.append(entityTitle);
    result.append(makeTable(
      ["token", "kind", "text", "start", "end"],
      transcript.redactedEntities.map((entity) => [entity.token, entity.kind, entity.text, formatNumber(entity.start), formatNumber(entity.end)]),
    ));
  }
  return result;
}

function appendClosedResult(closed) {
  removeDemandEmptyState();
  const block = document.createElement("article");
  block.className = "delivery-block closed-result";
  const heading = document.createElement("h3");
  heading.textContent = "SessionClosed";
  block.append(heading);
  const meta = document.createElement("div");
  meta.className = "closed-meta";
  meta.append(
    makeMetaItem("request_id", closed.requestId),
    makeMetaItem("audio_duration_seconds", formatNumber(closed.audioDurationSeconds)),
    makeMetaItem("session_duration_seconds", formatNumber(closed.sessionDurationSeconds)),
    makeMetaItem("delivery_failed", closed.deliveryFailed),
  );
  block.append(meta);
  elements.demandDeliveries.append(block);
}

function makeMetaItem(label, value) {
  const item = document.createElement("span");
  item.textContent = `${label}: ${value ?? ""}`;
  return item;
}

function handleBridgeMessage(message) {
  if (message === null || typeof message !== "object") return;
  if (message.op === "event") {
    appendRawLog(message);
    const event = message.event;
    if (event === null || typeof event !== "object") return;
    if (event.type === "SessionOpened") {
      state.sessionOpen = true;
      state.lastBridgeError = false;
      elements.sessionRequestId.textContent = event.requestId ?? "none";
      setStatus("Connected", "open");
      updateControls();
      void startStreamingCapture();
    } else if (event.type === "Segment" && state.mode === "instant") {
      appendInstantSegment(event);
    } else if (event.type === "Error") {
      state.lastBridgeError = true;
      setStatus(`SDK error: ${event.message ?? "request failed"}`, "error");
    } else if (event.type === "SessionClosed") {
      state.sessionOpen = false;
      if (!state.closing) setStatus("Closed", "idle");
      updateControls();
    }
    return;
  }

  if (message.op === "error") {
    appendRawLog(message);
    state.lastBridgeError = true;
    setStatus(`Error: ${message.message ?? "request failed"}`, "error");
    updateControls();
    if (!state.sessionOpen && bridgeIsOpen()) state.socket.close(1011, "bridge error");
    return;
  }

  if (message.op === "transcripts") {
    appendDeliveryBlock(`Finalize ${new Date().toLocaleTimeString()}`, message.transcripts);
    if (!state.closing) setStatus("Connected", "open");
    return;
  }

  if (message.op === "closed") {
    appendDeliveryBlock("CloseStream remainder", message.transcripts);
    if (message.closed !== null && typeof message.closed === "object") appendClosedResult(message.closed);
    state.sessionOpen = false;
    state.closing = false;
    setStatus("Closed", "idle");
    updateControls();
    state.socket?.close(1000, "session complete");
  }
}

function sendBridgeMessage(message) {
  if (!bridgeIsOpen()) {
    setStatus("Bridge is not open", "error");
    return false;
  }
  try {
    state.socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    setStatus(`Bridge send failed: ${error.message}`, "error");
    return false;
  }
}

function openBridge(mode) {
  if (bridgeIsActive()) return;
  const key = elements.apiKey.value.trim();
  if (key.length === 0) {
    setStatus("Enter an API key", "error");
    elements.apiKey.focus();
    return;
  }
  if (mode === "instant") resetInstantView();
  if (mode === "demand") {
    elements.demandDeliveries.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Waiting for the first delivery.";
    elements.demandDeliveries.append(empty);
  }
  state.mode = mode;
  state.sessionOpen = false;
  state.closing = false;
  state.lastBridgeError = false;
  elements.sessionRequestId.textContent = "none";
  setStatus("Opening bridge", "busy");
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${window.location.host}/bridge`);
  socket.binaryType = "arraybuffer";
  state.socket = socket;
  socket.addEventListener("open", () => {
    const options = featureOptions(mode === "demand");
    socket.send(JSON.stringify({
      op: "start",
      key,
      baseUrl: elements.baseUrl.value.trim() || "https://api.labs.bandwidth.com",
      mode,
      options,
    }));
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      appendRawLog({ op: "error", message: "bridge returned an unexpected binary message" });
      return;
    }
    try {
      handleBridgeMessage(JSON.parse(event.data));
    } catch (error) {
      appendRawLog({ op: "error", message: `invalid bridge message: ${error.message}` });
      setStatus("Invalid bridge message", "error");
    }
  });
  socket.addEventListener("error", () => {
    if (!state.lastBridgeError) setStatus("Bridge socket error", "error");
  });
  socket.addEventListener("close", () => {
    void stopCapture(false);
    if (state.socket !== socket) return;
    state.sessionOpen = false;
    updateControls();
    if (!state.lastBridgeError && !state.closing) setStatus("Disconnected", "idle");
    if (!state.closing) {
      state.mode = null;
      updateControls();
    }
  });
  updateControls();
}

async function startStreamingCapture() {
  if (state.capture !== null || state.mode === null || !state.sessionOpen) return;
  try {
    await startCapture("stream");
    updateControls();
  } catch (error) {
    setStatus(`Microphone error: ${error.message}`, "error");
    state.socket?.close(1011, "microphone unavailable");
  }
}

async function startCapture(kind) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser does not provide microphone capture");
  if (state.capture !== null) throw new Error("microphone capture is already active");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  let context;
  try {
    context = new AudioContext();
    if (!context.audioWorklet) throw new Error("AudioWorklet is unavailable in this browser");
    await context.audioWorklet.addModule("/audio-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, "pcm16-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetSampleRate: 16000 },
    });
    const capture = { kind, stream, context, source, processor, stopping: null };
    state.capture = capture;
    processor.port.addEventListener("message", handleAudioWorkletMessage);
    source.connect(processor);
    await context.resume();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    if (context !== undefined) await context.close().catch(() => {});
    throw error;
  }
}

function handleAudioWorkletMessage(event) {
  const data = event.data;
  if (data?.type === "flushed") {
    state.flushWaiter?.();
    state.flushWaiter = null;
    return;
  }
  if (data?.type !== "audio" || !(data.buffer instanceof ArrayBuffer)) return;
  const capture = state.capture;
  if (capture === null) return;
  const bytes = new Uint8Array(data.buffer);
  if (capture.kind === "record") {
    state.recordChunks.push(bytes.slice());
    return;
  }
  if (capture.kind === "stream" && bridgeIsOpen() && state.sessionOpen) {
    try {
      state.socket.send(bytes);
    } catch (error) {
      setStatus(`Audio send failed: ${error.message}`, "error");
    }
  }
}

async function stopCapture(flushRecord) {
  const capture = state.capture;
  if (capture === null) return;
  if (capture.stopping !== null) return capture.stopping;
  capture.stopping = (async () => {
    if (flushRecord && capture.kind === "record") {
      await new Promise((resolve) => {
        state.flushWaiter = resolve;
        capture.processor.port.postMessage({ type: "flush" });
        window.setTimeout(() => {
          if (state.flushWaiter === resolve) {
            state.flushWaiter = null;
            resolve();
          }
        }, 250);
      });
    }
    capture.source.disconnect();
    capture.processor.port.removeEventListener("message", handleAudioWorkletMessage);
    capture.processor.disconnect();
    for (const track of capture.stream.getTracks()) track.stop();
    await capture.context.close().catch(() => {});
    if (state.capture === capture) state.capture = null;
  })();
  return capture.stopping;
}

async function closeLiveSession() {
  await stopCapture(false);
  if (!bridgeIsOpen()) {
    updateControls();
    return;
  }
  state.closing = true;
  setStatus("Closing stream", "busy");
  sendBridgeMessage({ op: "close" });
  updateControls();
}

async function finalizeDemand() {
  if (!state.sessionOpen || state.mode !== "demand") return;
  setStatus("Finalizing", "busy");
  sendBridgeMessage({ op: "finalize" });
  updateControls();
}

function concatenateChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function makeWav(pcm) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: "audio/wav" });
}

async function recordTenSeconds() {
  if (bridgeIsActive() || state.recording) return;
  state.recording = true;
  state.recordChunks = [];
  state.selectedAudio = null;
  state.selectedAudioName = "";
  elements.fileName.textContent = "Recording...";
  elements.recordStatus.textContent = "Capturing 10 seconds at 16 kHz mono.";
  updateControls();
  try {
    await startCapture("record");
    await new Promise((resolve) => window.setTimeout(resolve, 10000));
    await stopCapture(true);
    const pcm = concatenateChunks(state.recordChunks);
    state.selectedAudio = makeWav(pcm);
    state.selectedAudioName = "browser-recording-10s.wav";
    elements.fileName.textContent = `${state.selectedAudioName} (${(state.selectedAudio.size / 1024).toFixed(1)} KB)`;
    elements.recordStatus.textContent = "Recording ready to send.";
  } catch (error) {
    await stopCapture(false);
    elements.fileName.textContent = "No file selected.";
    elements.recordStatus.textContent = `Recording failed: ${error.message}`;
  } finally {
    state.recording = false;
    updateControls();
  }
}

function queryFeatures(params) {
  const options = featureOptions(true);
  if (options.keywords?.length > 0) params.set("keywords", options.keywords.join(","));
  if (options.redactPii) params.set("redact_pii", "true");
  if (options.redactPiiPolicies?.length > 0) params.set("redact_pii_policies", options.redactPiiPolicies.join(","));
  if (options.redactPiiSub !== undefined) params.set("redact_pii_sub", options.redactPiiSub);
  if (options.redactPiiReturn) params.set("redact_pii_return", "true");
}

async function sendTranscription() {
  if (state.selectedAudio === null) return;
  const key = elements.apiKey.value.trim();
  if (key.length === 0) {
    setStatus("Enter an API key", "error");
    elements.apiKey.focus();
    return;
  }
  const params = new URLSearchParams({
    base_url: elements.baseUrl.value.trim() || "https://api.labs.bandwidth.com",
    raw: "false",
  });
  queryFeatures(params);
  elements.recordStatus.textContent = "Sending transcription request...";
  elements.transcribeSend.disabled = true;
  try {
    const response = await fetch(`/api/transcribe?${params.toString()}`, {
      method: "POST",
      headers: {
        "content-type": state.selectedAudio.type || "audio/wav",
        "x-console-key": key,
      },
      body: state.selectedAudio,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    renderTranscription(payload);
    elements.recordStatus.textContent = "Transcription complete.";
  } catch (error) {
    elements.recordStatus.textContent = `Transcription failed: ${error.message}`;
    renderTranscriptionError(error.message);
  } finally {
    updateControls();
  }
}

function renderTranscriptionError(message) {
  elements.transcribeResponse.replaceChildren();
  const error = document.createElement("div");
  error.className = "notice";
  error.textContent = message;
  elements.transcribeResponse.append(error);
}

function renderTranscription(result) {
  elements.transcribeResponse.replaceChildren();
  const summary = document.createElement("div");
  summary.className = "response-summary";
  const text = document.createElement("pre");
  text.className = "response-text";
  text.textContent = result.text ?? "";
  summary.append(text);

  const facts = document.createElement("dl");
  facts.className = "response-facts";
  facts.append(
    makeFact("audio_duration_seconds", formatNumber(result.audioDurationSeconds)),
    makeFact("model_info", formatJson(result.modelInfo)),
    makeFact("request_id", result.requestId),
  );
  summary.append(facts);
  elements.transcribeResponse.append(summary);

  appendResponseSection(
    elements.transcribeResponse,
    "segments",
    makeTable(
      ["start", "end", "text"],
      (Array.isArray(result.segments) ? result.segments : []).map((segment) => [segment.start, segment.end, segment.text]),
    ),
  );
  appendResponseSection(
    elements.transcribeResponse,
    "words",
    makeTable(
      ["word", "start", "end"],
      (Array.isArray(result.words) ? result.words : []).map((word) => [word.word, word.start, word.end]),
    ),
  );
  if (Array.isArray(result.redactedEntities)) {
    appendResponseSection(
      elements.transcribeResponse,
      "entities",
      makeTable(
        ["token", "kind", "text", "start", "end"],
        result.redactedEntities.map((entity) => [entity.token, entity.kind, entity.text, entity.start, entity.end]),
      ),
    );
  }
}

function makeFact(label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value ?? "";
  wrapper.append(term, detail);
  return wrapper;
}

function appendResponseSection(parent, title, content) {
  const section = document.createElement("section");
  section.className = "response-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, content);
  parent.append(section);
}

elements.toggleKey.addEventListener("click", () => {
  const showing = elements.apiKey.type === "text";
  elements.apiKey.type = showing ? "password" : "text";
  elements.toggleKey.textContent = showing ? "Show" : "Hide";
});

for (const tabName of tabNames) {
  $(`#tab-button-${tabName}`).addEventListener("click", () => setActiveTab(tabName));
}

elements.instantStart.addEventListener("click", () => openBridge("instant"));
elements.instantStop.addEventListener("click", () => void closeLiveSession());
elements.demandStart.addEventListener("click", () => openBridge("demand"));
elements.demandFinalize.addEventListener("click", () => void finalizeDemand());
elements.demandClose.addEventListener("click", () => void closeLiveSession());
elements.recordTen.addEventListener("click", () => void recordTenSeconds());
elements.transcribeSend.addEventListener("click", () => void sendTranscription());
elements.clearLog.addEventListener("click", clearRawLog);
elements.piiEnabled.addEventListener("change", updatePiiAvailability);
elements.piiReturn.addEventListener("change", () => {
  const selected = $(".substitution-radio:checked");
  if (elements.piiReturn.checked && selected?.value === "entity_name") $(".substitution-radio[value='hash']").checked = true;
  updatePiiAvailability();
});
for (const radio of $$(".substitution-radio")) {
  radio.addEventListener("change", () => {
    if (elements.piiReturn.checked && radio.value === "entity_name") $(".substitution-radio[value='hash']").checked = true;
  });
}
elements.wavFile.addEventListener("change", () => {
  const file = elements.wavFile.files?.[0];
  if (file === undefined) return;
  state.selectedAudio = file;
  state.selectedAudioName = file.name;
  elements.fileName.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  elements.recordStatus.textContent = "WAV selected.";
  updateControls();
});

updatePiiAvailability();
updateControls();
