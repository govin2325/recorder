// Service worker for handling audio transcription and summarization
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "audio") {
        handleAudioTranscription(msg);
    }
    return true;
});

async function handleAudioTranscription(msg) {
    try {
        console.log("Background: Received audio data");

        const { openaiKey } = await chrome.storage.local.get("openaiKey");

        if (!openaiKey) {
            sendMessage("transcript", "❌ API Key not set. Please enter your OpenAI API key.");
            sendMessage("status", "Ready");
            return;
        }

        // Convert audio to blob
        const audio = new Uint8Array(msg.audio);
        console.log(`Background: Audio size: ${audio.length} bytes`);

        const blob = new Blob([audio], { type: "audio/webm" });
        console.log(`Background: Created blob: ${blob.size} bytes`);

        // Transcribe audio
        sendMessage("status", "Transcribing audio...");
        console.log("Background: Starting transcription");

        const transcript = await transcribeAudio(blob, openaiKey);

        if (!transcript) {
            sendMessage("transcript", "❌ Transcription failed. Please try again.");
            sendMessage("status", "Ready");
            return;
        }

        console.log(`Background: Transcription complete: ${transcript.substring(0, 50)}...`);
        sendMessage("transcript", transcript);
        sendMessage("status", "Transcription complete");

        // Auto-summarize if transcript is long enough
        if (transcript.length > 200) {
            sendMessage("status", "Generating summary...");
            console.log("Background: Generating summary");

            const summary = await summarizeText(transcript, openaiKey);
            sendMessage("summary", summary);
            sendMessage("status", "Summary complete");
            console.log("Background: Summary complete");
        } else {
            sendMessage("summary", "⚠️ Transcript too short to summarize (minimum 200 characters).");
            sendMessage("status", "Ready");
        }

    } catch (error) {
        console.error("Background: Transcription error:", error);
        sendMessage("transcript", `❌ Error: ${error.message}`);
        sendMessage("status", "Error occurred");
    }
}

async function transcribeAudio(blob, apiKey) {
    try {
        const formData = new FormData();
        formData.append("file", blob, "audio.webm");
        formData.append("model", "whisper-1");
        // Remove language parameter to let Whisper auto-detect
        // formData.append("language", "en");

        console.log("Background: Sending request to OpenAI Whisper API");

        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`
            },
            body: formData
        });

        console.log(`Background: OpenAI response status: ${response.status}`);

        if (!response.ok) {
            const error = await response.json();
            console.error("Background: OpenAI error:", error);
            throw new Error(error.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        console.log("Background: Transcription received:", data);

        return data.text || "";

    } catch (error) {
        console.error("Background: Transcribe error:", error);
        throw error;
    }
}

async function summarizeText(text, apiKey) {
    try {
        console.log("Background: Sending summarization request");

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are a professional note-taking assistant. Convert meeting transcripts into clear, structured notes with a title, key points in bullet format, and action items."
                    },
                    {
                        role: "user",
                        content: `Please create structured notes from this transcript:

${text}

Format the output as:
# [Title]

## Key Points
• [Point 1]
• [Point 2]
...

## Action Items
• [Action 1]
• [Action 2]
...`
                    }
                ],
                temperature: 0.7,
                max_tokens: 1000
            })
        });

        console.log(`Background: Summary response status: ${response.status}`);

        if (!response.ok) {
            const error = await response.json();
            console.error("Background: Summary error:", error);
            throw new Error(error.error?.message || "Summarization failed");
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || "Unable to generate summary.";

    } catch (error) {
        console.error("Background: Summarize error:", error);
        throw error;
    }
}

function sendMessage(type, data) {
    chrome.runtime.sendMessage({ type, [type]: data }).catch(err => {
        console.log("Background: Message send failed:", err);
    });
}