import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.5.4/bundle.js";

const BAUD_RATE = 921600;
const FLASH_OFFSET = 0x0;

const log = document.getElementById("log");
const butConnect = document.getElementById("butConnect");
const butProgram = document.getElementById("butProgram");
const butTest = document.getElementById("butTest");
const firmwareSelect = document.getElementById("firmwareSelect");

let device = null;
let transport = null;
let esploader = null;
let progressLine = null;
let isTesting = false; // Track whether the terminal is running
let reader = null; // Store the reader for the ReadableStream
let writer = null; // Store the writer for the WritableStream, if any

// Example firmware files (replace with your actual firmware files)
const availableFirmware = [
    "firmware/ideaboardfirmware03202025.bin"
];

document.addEventListener("DOMContentLoaded", () => {
    butConnect.addEventListener("click", clickConnect);
    butProgram.addEventListener("click", clickProgram);
    butTest.addEventListener("click", clickTest);

    if ("serial" in navigator) {
        document.getElementById("notSupported").style.display = "none";
    }

    // Populate firmware dropdown
    availableFirmware.forEach(firmware => {
        const option = document.createElement("option");
        option.value = firmware;
        option.textContent = firmware.split('/').pop(); // Show only filename
        firmwareSelect.appendChild(option);
    });

    logLine("Ideaboard Flasher loaded.");
});

function logLine(text) {
    if (text.startsWith("Programming: ")) return;
    if (text.startsWith("Writing at")) {
        if (!progressLine) {
            progressLine = document.createElement("div");
            log.appendChild(progressLine);
        }
        progressLine.textContent = text;
        log.scrollTop = log.scrollHeight;
        return;
    }
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
    if (transport) {
        // Stop any ongoing terminal session
        if (isTesting) {
            await stopTest();
        }
        await transport.disconnect();
        await sleep(1500);
        toggleUI(false);
        transport = null;
        if (device) {
            await cleanupPort();
            device = null;
        }
        return;
    }

    try {
        device = await navigator.serial.requestPort({});
        transport = new Transport(device, true);
        const loaderOptions = {
            transport: transport,
            baudrate: BAUD_RATE,
            terminal: {
                clean: () => (log.innerHTML = ""),
                writeLine: (data) => logLine(data),
                write: (data) => {
                    const line = document.createElement("div");
                    line.textContent = data;
                    log.appendChild(line);
                    log.scrollTop = log.scrollHeight;
                },
            },
        };
        esploader = new ESPLoader(loaderOptions);
        await esploader.main("default_reset");
        toggleUI(true);
        logLine(`Connected at ${BAUD_RATE} baud.`);
    } catch (e) {
        logError(e.message);
        toggleUI(false);
    }
}

async function clickProgram() {
    const selectedFirmware = firmwareSelect.value;
    if (!selectedFirmware) {
        logError("Please select a firmware file first");
        return;
    }

    if (!confirm("This will erase and program the flash. Continue?")) return;

    // Stop any ongoing terminal session
    if (isTesting) {
        await stopTest();
    }

    butProgram.disabled = true;
    progressLine = null;
    try {
        logLine("Erasing flash...");
        const eraseStart = Date.now();
        await esploader.eraseFlash();
        logLine(`Erase completed in ${Date.now() - eraseStart}ms.`);

        logLine("Fetching firmware...");
        const response = await fetch(selectedFirmware);
        if (!response.ok) throw new Error("Failed to fetch firmware");
        const arrayBuffer = await response.arrayBuffer();
        const firmwareData = arrayBufferToBinaryString(arrayBuffer);

        const flashOptions = {
            fileArray: [{ data: firmwareData, address: FLASH_OFFSET }],
            flashSize: "keep",
            eraseAll: false,
            compress: true,
            reportProgress: () => {},
            calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
        };

        logLine(`Programming firmware at offset 0x${FLASH_OFFSET.toString(16)}...`);
        const programStart = Date.now();
        await esploader.writeFlash(flashOptions);
        logLine(`Programming completed in ${Date.now() - programStart}ms.`);
        logLine("Firmware installed successfully. Reset your device to run it.");

        // Clean up after flashing
        await transport.disconnect(); // Ensure esptool-js releases the port
        await cleanupPort();
        transport = null;
        device = null;
        toggleUI(false); // Force the user to reconnect
        logLine("Please reconnect to the device to continue.");
    } catch (e) {
        logError(e.message);
    } finally {
        butProgram.disabled = !transport;
    }
}

async function clickTest() {
    if (isTesting) {
        // If already testing, stop the terminal
        await stopTest();
        return;
    }

    if (!transport || !device) {
        logError("Please connect to a device first");
        return;
    }

    try {
        // Clean up the port to ensure no existing readers or writers
        await cleanupPort();

        // Open the port
        await device.open({ baudRate: BAUD_RATE });

        logLine("Starting serial terminal... Click Stop to exit.");
        isTesting = true;
        butTest.textContent = "Stop";
        butTest.style.backgroundColor = "#e74c3c"; // Red to indicate "Stop"

        const decoder = new TextDecoder();
        reader = device.readable.getReader();

        // Clear existing log for a clean terminal view
        log.innerHTML = "";

        while (isTesting) {
            const { value, done } = await reader.read();
            if (done) {
                logLine("Serial read stream ended.");
                break;
            }
            const text = decoder.decode(value);
            logLine(text.trim()); // Display each line of output
        }
    } catch (e) {
        logError(`Test failed: ${e.message}`);
    } finally {
        await stopTest();
    }
}

async function stopTest() {
    isTesting = false;
    butTest.textContent = "Test";
    butTest.style.backgroundColor = ""; // Reset to default color

    try {
        // Release the reader if it exists
        if (reader) {
            await reader.cancel(); // Cancel the reader to stop reading
            reader.releaseLock(); // Release the lock on the ReadableStream
            reader = null;
        }

        // Release the writer if it exists
        if (writer) {
            await writer.close(); // Close the writer
            writer.releaseLock(); // Release the lock on the WritableStream
            writer = null;
        }

        // Close the port if it's open
        if (device && (device.readable || device.writable)) {
            await device.close();
        }

        logLine("Serial terminal stopped.");
    } catch (e) {
        logError(`Failed to stop terminal: ${e.message}`);
    }
}

async function cleanupPort() {
    try {
        // Release any existing reader
        if (reader) {
            await reader.cancel();
            reader.releaseLock();
            reader = null;
        }

        // Release any existing writer
        if (writer) {
            await writer.close();
            writer.releaseLock();
            writer = null;
        }

        // Close the port if it's open
        if (device && (device.readable || device.writable)) {
            await device.close();
        }
    } catch (e) {
        logError(`Failed to clean up port: ${e.message}`);
    }
}

function toggleUI(connected) {
    butConnect.textContent = connected ? "Disconnect" : "Connect";
    butProgram.disabled = !connected;
    butTest.disabled = !connected;
    if (!connected && isTesting) {
        stopTest(); // Stop testing if disconnecting
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function arrayBufferToBinaryString(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
    }
    return binaryString;
}