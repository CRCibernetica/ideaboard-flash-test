const BAUD_RATE = 115200; // Baud rate for serial communication

const log = document.getElementById("log");
const butConnect = document.getElementById("butConnect");
const butStart = document.getElementById("butStart");

let port = null;
let reader = null;
let isMonitoring = false;

// Function to clean serial output by removing control characters except newlines
function cleanSerialOutput(text) {
    // Remove ANSI escape sequences (e.g., \x1B[...m, \x1B[...G, etc.)
    text = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
               .replace(/\x1B\]0;.*?\x07/g, '')
               .replace(/\x1B\]0;.*?\x5C/g, '');
    // Remove control characters except \n
    text = text.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
    // Normalize line endings: replace \r\n with \n, remove standalone \r
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

document.addEventListener("DOMContentLoaded", () => {
    butConnect.addEventListener("click", clickConnect);
    butStart.addEventListener("click", clickStart);

    if ("serial" in navigator) {
        document.getElementById("notSupported").style.display = "none";
    }

    logLine("Ideaboard Serial Monitor loaded.");
});

function logLine(text) {
    const line = document.createElement("div");
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function logError(text) {
    const line = document.createElement("div");
    line.innerHTML = `<span style="color: red;">Error: ${text}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

async function clickConnect() {
    if (port) {
        // If already connected, disconnect
        if (isMonitoring) {
            await stopMonitoring();
        }
        try {
            await port.close();
            port = null;
            toggleUI(false);
            logLine("Disconnected from serial port.");
        } catch (e) {
            logError(`Disconnect failed: ${e.message}`);
        }
        return;
    }

    try {
        // Request a serial port
        port = await navigator.serial.requestPort({});
        toggleUI(true);
        logLine("Connected to serial port.");
    } catch (e) {
        logError(`Failed to connect: ${e.message}`);
        port = null;
        toggleUI(false);
    }
}

async function clickStart() {
    if (isMonitoring) {
        // If already monitoring, stop
        await stopMonitoring();
        return;
    }

    if (!port) {
        logError("Please connect to a serial port first.");
        return;
    }

    try {
        // Open the port at 115200 baud
        await port.open({ baudRate: BAUD_RATE });
        logLine(`Started monitoring at ${BAUD_RATE} baud. Click Stop to end.`);

        isMonitoring = true;
        butStart.textContent = "Stop";
        butStart.style.backgroundColor = "#e74c3c"; // Red to indicate "Stop"

        // Clear the log
        log.innerHTML = "";

        const decoder = new TextDecoder();
        reader = port.readable.getReader();

        while (isMonitoring) {
            const { value, done } = await reader.read();
            if (done) {
                logLine("Serial stream ended.");
                break;
            }
            const text = decoder.decode(value);
            const cleanedText = cleanSerialOutput(text);
            const lines = cleanedText.split('\n');
            lines.forEach(line => {
                if (line) {
                    logLine(line);
                }
            });
        }
    } catch (e) {
        logError(`Monitoring failed: ${e.message}`);
    } finally {
        await stopMonitoring();
    }
}

async function stopMonitoring() {
    isMonitoring = false;
    butStart.textContent = "Start";
    butStart.style.backgroundColor = ""; // Reset to default color

    try {
        if (reader) {
            await reader.cancel();
            reader.releaseLock();
            reader = null;
        }
        if (port && port.readable) {
            await port.close();
        }
        logLine("Stopped monitoring serial port.");
    } catch (e) {
        logError(`Failed to stop monitoring: ${e.message}`);
    }
}

function toggleUI(connected) {
    butConnect.textContent = connected ? "Disconnect" : "Connect";
    butStart.disabled = !connected;
}