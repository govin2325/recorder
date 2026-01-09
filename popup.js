// State management
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let audioContext = null;
let sourceNode = null;
let destinationNode = null;

// DOM Elements
const elements = {
    apiKey: document.getElementById("apiKey"),
    saveKey: document.getElementById("saveKey"),
    toggleKey: document.getElementById("toggleKey"),
    startMic: document.getElementById("startMic"),
    stopMic: document.getElementById("stopMic"),
    tabRecord: document.getElementById("tabRecord"),
    transcript: document.getElementById("transcript"),
    summary: document.getElementById("summary"),
    copyText: document.getElementById("copyText"),
    exportTxt: document.getElementById("exportTxt"),
    exportMd: document.getElementById("exportMd"),
    clearAll: document.getElementById("clearAll"),
    statusIndicator: document.getElementById("statusIndicator"),
    recordingInfo: document.getElementById("recordingInfo"),
    recordingTimer: document.getElementById("recordingTimer")
};

// Initialize extension
initialize();

function initialize() {
    console.log("=== EXTENSION INITIALIZED ===");
    loadSavedApiKey();
    setupEventListeners();
    setupTabSwitching();
    setupMessageListener();
}

// Load saved API key
function loadSavedApiKey() {
    chrome.storage.local.get("openaiKey", ({ openaiKey }) => {
        if (openaiKey) {
            elements.apiKey.value = openaiKey;
            console.log("API key loaded from storage");
        } else {
            console.log("No API key in storage");
        }
    });
}

// Setup all event listeners
function setupEventListeners() {
    elements.saveKey.addEventListener("click", saveApiKey);
    elements.toggleKey.addEventListener("click", toggleKeyVisibility);
    elements.startMic.addEventListener("click", startMicRecording);
    elements.tabRecord.addEventListener("click", startTabRecording);
    elements.stopMic.addEventListener("click", stopRecording);
    elements.copyText.addEventListener("click", copyToClipboard);
    elements.exportTxt.addEventListener("click", exportAsTxt);
    elements.exportMd.addEventListener("click", exportAsMarkdown);
    elements.clearAll.addEventListener("click", clearAllContent);

    // Allow Enter key to save API key
    elements.apiKey.addEventListener("keypress", (e) => {
        if (e.key === "Enter") saveApiKey();
    });
}

// Tab switching functionality
function setupTabSwitching() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.output-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.add('active');
        });
    });
}

// Save API Key with validation
async function saveApiKey() {
    const key = elements.apiKey.value.trim();

    if (!key) {
        showNotification("Please enter an API key", "error");
        return;
    }

    if (!key.startsWith("sk-")) {
        showNotification("Invalid API key format (should start with sk-)", "error");
        return;
    }

    // Test the API key
    updateStatus("Testing API key...", "processing");

    try {
        const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "testApi", apiKey: key }, resolve);
        });

        if (result.success) {
            chrome.storage.local.set({ openaiKey: key }, () => {
                showNotification("✅ API Key saved and validated!", "success");
                updateStatus("Ready");
                console.log("API key saved successfully");
            });
        } else {
            showNotification("❌ " + result.message, "error");
            updateStatus("Ready");
            console.error("API key validation failed:", result.message);
        }
    } catch (error) {
        console.error("API test error:", error);
        // Save anyway if we can't test
        chrome.storage.local.set({ openaiKey: key }, () => {
            showNotification("⚠️ API Key saved (validation failed, will test on recording)", "success");
            updateStatus("Ready");
        });
    }
}

// Toggle API key visibility
function toggleKeyVisibility() {
    const input = elements.apiKey;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    elements.toggleKey.textContent = isPassword ? "🙈" : "👁️";
}

// Start microphone recording
async function startMicRecording() {
    console.log("=== STARTING MICROPHONE RECORDING ===");
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100
            }
        });
        console.log("Microphone access granted");
        startRecording(stream, "Microphone");
    } catch (err) {
        console.error("Microphone error:", err);
        showNotification("Microphone access denied: " + err.message, "error");
    }
}

// Start tab audio recording with audio output
async function startTabRecording() {
    console.log("=== STARTING TAB RECORDING ===");
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        console.log("Current tab:", tab);

        chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
            if (chrome.runtime.lastError) {
                console.error("Tab capture error:", chrome.runtime.lastError);
                showNotification("Tab capture failed: " + chrome.runtime.lastError.message, "error");
                return;
            }

            if (!stream) {
                console.error("No stream received");
                showNotification("Failed to capture tab audio. Make sure the tab is playing audio.", "error");
                return;
            }

            console.log("Tab stream received:", stream);
            console.log("Audio tracks:", stream.getAudioTracks());

            // Create audio context to route audio to speakers
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("AudioContext created:", audioContext.state);

                sourceNode = audioContext.createMediaStreamSource(stream);
                destinationNode = audioContext.createMediaStreamDestination();

                // Connect source to destination for recording
                sourceNode.connect(destinationNode);

                // Also connect to speakers so you can hear it
                sourceNode.connect(audioContext.destination);

                console.log("Audio routing setup complete");

                // Use the original stream for recording (it has better compatibility)
                startRecording(stream, "Tab Audio");
            } catch (audioErr) {
                console.error("Audio context error:", audioErr);
                // Fallback: record without audio output
                startRecording(stream, "Tab Audio");
            }
        });
    } catch (err) {
        console.error("Tab capture setup error:", err);
        showNotification("Tab capture error: " + err.message, "error");
    }
}

// Start recording with given stream
function startRecording(stream, source) {
    console.log(`=== STARTING RECORDING: ${source} ===`);

    try {
        // Check audio tracks
        const audioTracks = stream.getAudioTracks();
        console.log("Audio tracks:", audioTracks);

        if (audioTracks.length === 0) {
            throw new Error("No audio track in stream");
        }

        // Check for supported MIME types
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];

        let selectedMimeType = '';
        for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                selectedMimeType = type;
                console.log(`Selected MIME type: ${type}`);
                break;
            }
        }

        if (!selectedMimeType) {
            console.warn("No preferred MIME type supported, using default");
        }

        const options = selectedMimeType ? { mimeType: selectedMimeType } : {};
        mediaRecorder = new MediaRecorder(stream, options);

        console.log("MediaRecorder created with:", {
            mimeType: mediaRecorder.mimeType,
            state: mediaRecorder.state
        });

        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
                console.log(`Audio chunk #${audioChunks.length}: ${event.data.size} bytes`);
            }
        };

        mediaRecorder.onstop = async () => {
            console.log("=== RECORDING STOPPED ===");
            console.log(`Total chunks: ${audioChunks.length}`);
            await processRecording(stream);
        };

        mediaRecorder.onerror = (error) => {
            console.error("MediaRecorder error:", error);
            showNotification("Recording error occurred", "error");
            stopRecording();
        };

        mediaRecorder.start(1000); // Collect data every second
        console.log("MediaRecorder started");

        // Update UI
        setRecordingState(true, source);
        startTimer();

        // Clear previous content
        clearContent();

    } catch (err) {
        console.error("Start recording error:", err);
        showNotification("Failed to start recording: " + err.message, "error");
        stream.getTracks().forEach(track => track.stop());
        cleanupAudioContext();
    }
}

// Stop recording
function stopRecording() {
    console.log("=== STOP RECORDING CALLED ===");

    if (mediaRecorder) {
        console.log("MediaRecorder state:", mediaRecorder.state);

        if (mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
    }

    setRecordingState(false);
    stopTimer();
}

// Cleanup audio context
function cleanupAudioContext() {
    console.log("Cleaning up audio context");

    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
        audioContext = null;
    }
}

// Process recorded audio
async function processRecording(stream) {
    console.log("=== PROCESSING RECORDING ===");

    try {
        console.log(`Total audio chunks: ${audioChunks.length}`);

        if (audioChunks.length === 0) {
            showNotification("❌ No audio data recorded", "error");
            updateStatus("Ready");
            return;
        }

        // Calculate total size
        const totalSize = audioChunks.reduce((acc, chunk) => acc + chunk.size, 0);
        console.log(`Total audio size: ${totalSize} bytes`);

        const blob = new Blob(audioChunks, { type: "audio/webm" });
        console.log(`Created blob: ${blob.size} bytes, type: ${blob.type}`);

        if (blob.size < 1000) {
            showNotification("❌ Recording too short. Please record for at least 3 seconds.", "error");
            updateStatus("Ready");
            return;
        }

        const arrayBuffer = await blob.arrayBuffer();
        console.log(`ArrayBuffer size: ${arrayBuffer.byteLength} bytes`);

        // Stop all tracks
        stream.getTracks().forEach(track => {
            console.log(`Stopping track: ${track.kind}`);
            track.stop();
        });

        // Cleanup audio context
        cleanupAudioContext();

        // Show transcript tab
        document.querySelector('[data-target="transcript"]').click();

        // Update status
        updateStatus("Transcribing...", "processing");
        elements.transcript.innerHTML = '<p class="placeholder">🔄 Processing audio...</p>';

        // Send to background script
        console.log("Sending audio to background script...");
        const audioArray = Array.from(new Uint8Array(arrayBuffer));
        console.log(`Sending ${audioArray.length} bytes to background`);

        chrome.runtime.sendMessage({
            type: "audio",
            audio: audioArray
        });

        console.log("Audio sent to background script");

    } catch (err) {
        console.error("Processing error:", err);
        showNotification("Failed to process recording: " + err.message, "error");
        updateStatus("Ready");
        cleanupAudioContext();
    }
}

// Update recording state
function setRecordingState(isRecording, source = "") {
    elements.startMic.disabled = isRecording;
    elements.tabRecord.disabled = isRecording;
    elements.stopMic.disabled = !isRecording;

    if (isRecording) {
        elements.statusIndicator.classList.add("recording");
        elements.recordingInfo.classList.remove("hidden");
        updateStatus(`Recording ${source}...`, "recording");
    } else {
        elements.statusIndicator.classList.remove("recording", "processing");
        elements.recordingInfo.classList.add("hidden");
        updateStatus("Ready");
    }
}

// Timer functions
function startTimer() {
    recordingStartTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    elements.recordingTimer.textContent = `${minutes}:${seconds}`;
}

// Update status indicator
function updateStatus(text, state = "") {
    const statusText = elements.statusIndicator.querySelector(".status-text");
    statusText.textContent = text;

    elements.statusIndicator.classList.remove("recording", "processing");
    if (state) {
        elements.statusIndicator.classList.add(state);
    }
}

// Handle messages from background script
function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg) => {
        console.log("Popup: Received message:", msg.type);

        if (msg.type === "transcript") {
            handleTranscript(msg.transcript);
        } else if (msg.type === "summary") {
            handleSummary(msg.summary);
        } else if (msg.type === "status") {
            updateStatus(msg.status, msg.state || "processing");
        }
    });
}

function handleTranscript(text) {
    console.log("Handling transcript:", text.substring(0, 100));
    elements.transcript.textContent = text;

    if (text.startsWith("❌")) {
        showNotification("Transcription failed", "error");
        updateStatus("Ready");
    } else {
        showNotification("✅ Transcription complete!", "success");
    }
}

function handleSummary(text) {
    console.log("Handling summary");
    elements.summary.textContent = text;

    // Highlight summary tab briefly
    const summaryTab = document.querySelector('[data-target="summary"]');
    const originalText = summaryTab.innerHTML;
    summaryTab.innerHTML = originalText + ' <span style="color: #10b981;">●</span>';

    setTimeout(() => {
        summaryTab.innerHTML = originalText;
    }, 3000);
}

// Clear content
function clearContent() {
    elements.transcript.innerHTML = '<p class="placeholder">Your transcription will appear here...</p>';
    elements.summary.innerHTML = '<p class="placeholder">Summary will be generated automatically...</p>';
}

function clearAllContent() {
    if (confirm("Are you sure you want to clear all content?")) {
        clearContent();
        showNotification("Content cleared", "success");
    }
}

// Export functions
function copyToClipboard() {
    const transcript = elements.transcript.textContent;
    const summary = elements.summary.textContent;

    if (!transcript || transcript.includes("placeholder")) {
        showNotification("No content to copy", "error");
        return;
    }

    const content = `TRANSCRIPT:\n\n${transcript}\n\n${summary.includes("placeholder") ? "" : `SUMMARY:\n\n${summary}`}`;

    navigator.clipboard.writeText(content).then(() => {
        showNotification("Copied to clipboard", "success");
    }).catch(() => {
        showNotification("Failed to copy", "error");
    });
}

function exportAsTxt() {
    const transcript = elements.transcript.textContent;
    const summary = elements.summary.textContent;

    if (!transcript || transcript.includes("placeholder")) {
        showNotification("No content to export", "error");
        return;
    }

    const content = `AI AUDIO NOTES
Generated: ${new Date().toLocaleString()}

TRANSCRIPT:
${transcript}

${summary.includes("placeholder") ? "" : `SUMMARY:
${summary}`}`;

    downloadFile(content, `notes-${Date.now()}.txt`, "text/plain");
    showNotification("Exported as TXT", "success");
}

function exportAsMarkdown() {
    const transcript = elements.transcript.textContent;
    const summary = elements.summary.textContent;

    if (!transcript || transcript.includes("placeholder")) {
        showNotification("No content to export", "error");
        return;
    }

    const content = `# AI Audio Notes
*Generated: ${new Date().toLocaleString()}*

## Transcript
${transcript}

${summary.includes("placeholder") ? "" : `## Summary
${summary}`}`;

    downloadFile(content, `notes-${Date.now()}.md`, "text/markdown");
    showNotification("Exported as Markdown", "success");
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Notification system
function showNotification(message, type = "info") {
    console.log(`[${type.toUpperCase()}] ${message}`);

    // Visual feedback in UI
    const statusText = elements.statusIndicator.querySelector(".status-text");
    const originalText = statusText.textContent;

    statusText.textContent = message;

    setTimeout(() => {
        if (statusText.textContent === message) {
            statusText.textContent = originalText;
        }
    }, 3000);
}