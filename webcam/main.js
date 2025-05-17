let mediaRecorder;
let recordedBlobs;
let originalRecordedBlob; // To store the full recording before edits

// FFmpeg setup
const { createFFmpeg, fetchFile } = FFmpeg;
let ffmpeg;

// BodyPix setup
let bodyPixModel = null;
let animationFrameId = null;

// Intermediary canvas for BodyPix input
const tempBodyPixInputCanvas = document.createElement('canvas');
const tempBodyPixInputCtx = tempBodyPixInputCanvas.getContext('2d');

// DOM element variables - will be assigned once DOM is loaded
let errorMsgElement;
let recordedVideo;
let recordButton;
let playButton;
let applyEditsButton;
let liveWidthDisplay;
let liveHeightDisplay;
let gumVideo;
let processedGumCanvas;
let processedGumCtx;
let blurToggle;
let blurAmountSlider;
let startButton;
// Crop overlay elements
let cropOverlay;
let cropBoxElement;
let cropHandles = {};
let isDraggingCropHandle = false;
let currentCropHandle = null;
let cropStartX, cropStartY; // For dragging calculations
let cropRect = { x: 0, y: 0, w: 0, h: 0 }; // Relative to canvas
// Progress bar elements
let ffmpegProgressSection;
let ffmpegProgressBar;
let ffmpegProgressText;
let ffmpegProgressTime;

function updateStatus(message, type = 'info') { // 'info', 'error', 'success', 'loading'
    if (!errorMsgElement) errorMsgElement = document.getElementById('statusMessage'); // Ensure it's assigned
    if (errorMsgElement) {
        errorMsgElement.textContent = message;
        errorMsgElement.className = ''; // Clear existing classes
        if (type === 'error') {
            errorMsgElement.classList.add('status-error');
        } else if (type === 'success') {
            errorMsgElement.classList.add('status-success');
        } else if (type === 'loading') {
            errorMsgElement.classList.add('status-info'); // Or a specific loading class
            // Add a spinner icon if desired
            // errorMsgElement.innerHTML = message + ' <span class="loader"></span>';
        }
         else {
            errorMsgElement.classList.add('status-info');
        }
    }
}

async function loadFFmpeg() {
  if (!ffmpeg) {
    updateStatus("Loading FFmpeg-core...", 'loading');
    ffmpeg = createFFmpeg({
      log: true, // Set to true to see FFmpeg logs in the console
      // IMPORTANT: You might need to host these files yourself for production
      // corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
      // For newer versions (e.g., 0.12.x), corePath might point to a .wasm or .js file,
      // and you might need to configure wasmPath and workerPath.
      // Check the specific version's documentation. For 0.11.0, this often works:
      corePath: new URL('https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js', document.baseURI).href,
    });
    await ffmpeg.load();
    updateStatus("FFmpeg loaded.", 'success');
  }
  return ffmpeg;
}

async function loadBodyPixModel() {
  if (!bodyPixModel) {
    updateStatus("Loading BodyPix model...", 'loading');
    try {
      // Model configuration - can be adjusted for performance/accuracy
      bodyPixModel = await bodyPix.load({
        architecture: 'MobileNetV1',
        outputStride: 16,
        multiplier: 0.75,
        quantBytes: 2 // Can be 1, 2, or 4. Smaller is faster but less accurate.
      });
      updateStatus("BodyPix model loaded.", 'success');
      if(blurToggle) { blurToggle.disabled = false; if(blurAmountSlider) blurAmountSlider.disabled = false; }
    } catch (e) {
      console.error("Error loading BodyPix model:", e);
      updateStatus(`Error loading BodyPix model: ${e.toString()}`, 'error');
    }
  }
}

function handleDataAvailable(event) {
  if (event.data && event.data.size > 0) recordedBlobs.push(event.data);
}

function startRecording() {
  recordedBlobs = [];
  let options = { mimeType: "video/webm;codecs=vp9,opus" };
  // Capture stream from the canvas that shows the (potentially) blurred video
  const canvasStream = processedGumCanvas.captureStream();
  // Make sure to get audio from the original stream if needed
  if (window.stream && window.stream.getAudioTracks().length > 0) {
    canvasStream.addTrack(window.stream.getAudioTracks()[0]);
  }

  try {
    mediaRecorder = new MediaRecorder(canvasStream, options);
  } catch (e) {
    console.error("Exception while creating MediaRecorder:", e);
    updateStatus(`Exception while creating MediaRecorder: ${e.toString()}`, 'error');
    return;
  }
  recordButton.textContent = "Stop Recording";
  playButton.disabled = true;
  applyEditsButton.disabled = true;
  mediaRecorder.onstop = (event) => {
    originalRecordedBlob = new Blob(recordedBlobs, { type: "video/webm" });
  };
  mediaRecorder.ondataavailable = handleDataAvailable;
  mediaRecorder.start();
  console.log("MediaRecorder started", mediaRecorder);
}

function stopRecording() {
  mediaRecorder.stop();
}

async function renderLoop() {
  if (!gumVideo.srcObject || gumVideo.paused || gumVideo.ended ||
      gumVideo.videoWidth === 0 || gumVideo.videoHeight === 0 || // Check video dimensions
      gumVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || // readyState >= 3 (more robust)
      processedGumCanvas.width === 0 || processedGumCanvas.height === 0) { // Added dimension checks
    // console.log('Render loop skipped: Video not ready.'); // Optional: uncomment for verbose logging
    animationFrameId = requestAnimationFrame(renderLoop);
    return;
  }

  if (blurToggle.checked && bodyPixModel) {
    try {
      // Ensure tempBodyPixInputCanvas has the current, valid dimensions of gumVideo
      if (tempBodyPixInputCanvas.width !== gumVideo.videoWidth || tempBodyPixInputCanvas.height !== gumVideo.videoHeight) {
        if (gumVideo.videoWidth > 0 && gumVideo.videoHeight > 0) {
          tempBodyPixInputCanvas.width = gumVideo.videoWidth;
          tempBodyPixInputCanvas.height = gumVideo.videoHeight;
        } else {
          // This case should ideally be caught by the initial checks in renderLoop
          console.warn("renderLoop (blur path): gumVideo dimensions became zero before drawing to temp canvas. Drawing raw frame to output.");
          if (processedGumCanvas.width > 0 && processedGumCanvas.height > 0) { // Check output canvas too
            processedGumCtx.drawImage(gumVideo, 0, 0, processedGumCanvas.width, processedGumCanvas.height);
          }
          animationFrameId = requestAnimationFrame(renderLoop);
          return;
        }
      }

      // Draw current gumVideo frame to our intermediary canvas
      tempBodyPixInputCtx.drawImage(gumVideo, 0, 0, tempBodyPixInputCanvas.width, tempBodyPixInputCanvas.height);

      // Now use tempBodyPixInputCanvas as the input for BodyPix operations
      const segmentation = await bodyPixModel.segmentPerson(tempBodyPixInputCanvas, {
        flipHorizontal: false,
        internalResolution: 'medium', // 'low', 'medium', 'high', 'full'
        segmentationThreshold: 0.7, // Adjust as needed
      });
      // Parameters for drawBokehEffect:
      // canvas, input (video/image/canvas), segmentation, backgroundBlurAmount, edgeBlurAmount, flipHorizontal
      const backgroundBlurAmount = blurAmountSlider ? parseInt(blurAmountSlider.value, 10) : 6; // Use slider value
      const edgeBlurAmount = 3;       // Smooths edges (slightly increased for potentially better look)
      const flipHorizontal = false;

      // console.log(`Before drawBokehEffect: gumVideo dimensions: ${gumVideo.videoWidth}x${gumVideo.videoHeight}, readyState: ${gumVideo.readyState}`);
      // console.log(`Before drawBokehEffect: tempBodyPixInputCanvas dimensions: ${tempBodyPixInputCanvas.width}x${tempBodyPixInputCanvas.height}`);
      // console.log('Drawing bokeh effect...'); // Optional: uncomment for verbose logging
      bodyPix.drawBokehEffect(
        processedGumCanvas, tempBodyPixInputCanvas, segmentation, backgroundBlurAmount,
        edgeBlurAmount, flipHorizontal
      );
      // console.log('Bokeh effect drawn.'); // Optional: uncomment for verbose logging
    } catch (e) {
      // Fallback to drawing without blur if segmentation fails
      console.error("BodyPix segmentation or drawing failed, falling back to simple drawImage:", e);
      // Ensure processedGumCanvas and gumVideo are valid for fallback
      if (processedGumCanvas.width > 0 && processedGumCanvas.height > 0 &&
          gumVideo.videoWidth > 0 && gumVideo.videoHeight > 0 &&
          gumVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { // readyState >= 2 for fallback
         processedGumCtx.drawImage(gumVideo, 0, 0, processedGumCanvas.width, processedGumCanvas.height);
      } else {
        console.error("Fallback drawImage in blur path skipped: processedGumCanvas or gumVideo has invalid dimensions/state.");
      }
    }
  } else {
    // Blur is OFF: Draw directly from gumVideo to processedGumCanvas
    if (processedGumCanvas.width > 0 && processedGumCanvas.height > 0 &&
        gumVideo.videoWidth > 0 && gumVideo.videoHeight > 0 &&
        gumVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { // readyState >= 2
      processedGumCtx.drawImage(gumVideo, 0, 0, processedGumCanvas.width, processedGumCanvas.height);
    }
  }
  animationFrameId = requestAnimationFrame(renderLoop);
}
// This function will try to find DOM elements and set up event listeners.

function updateCropInputs() {
    document.getElementById('cropX').value = Math.round(cropRect.x);
    document.getElementById('cropY').value = Math.round(cropRect.y);
    document.getElementById('cropW').value = Math.round(cropRect.w);
    document.getElementById('cropH').value = Math.round(cropRect.h);
}

function drawCropOverlay() {
    if (!cropBoxElement || !processedGumCanvas || !cropOverlay) return;

    // Calculate scaling factors for displaying the cropRect (which is in canvas surface coordinates)
    // on the cropOverlay (which matches the displayed canvas size).
    const displayScaleX = cropOverlay.offsetWidth / processedGumCanvas.width;
    const displayScaleY = cropOverlay.offsetHeight / processedGumCanvas.height;


    // Ensure cropRect values are within canvas bounds
    cropRect.x = Math.max(0, Math.min(cropRect.x, processedGumCanvas.width - cropRect.w));
    cropRect.y = Math.max(0, Math.min(cropRect.y, processedGumCanvas.height - cropRect.h));
    cropRect.w = Math.max(10, Math.min(cropRect.w, processedGumCanvas.width - cropRect.x)); // Min width 10
    cropRect.h = Math.max(10, Math.min(cropRect.h, processedGumCanvas.height - cropRect.y)); // Min height 10

    // Apply scaling for display
    cropBoxElement.style.left = (cropRect.x * displayScaleX) + 'px';
    cropBoxElement.style.top = (cropRect.y * displayScaleY) + 'px';
    cropBoxElement.style.width = (cropRect.w * displayScaleX) + 'px';
    cropBoxElement.style.height = (cropRect.h * displayScaleY) + 'px';


    // Position handles (simplified: top-left and bottom-right)
    if (cropHandles.tl) {
        // Center handle on the scaled corner. offsetWidth/Height are of the handle itself.
        cropHandles.tl.style.left = (cropRect.x * displayScaleX - cropHandles.tl.offsetWidth / 2) + 'px';
        cropHandles.tl.style.top = (cropRect.y * displayScaleY - cropHandles.tl.offsetHeight / 2) + 'px';
    }
    if (cropHandles.br) {
        cropHandles.br.style.left = ((cropRect.x + cropRect.w) * displayScaleX - cropHandles.br.offsetWidth / 2) + 'px';
        cropHandles.br.style.top = ((cropRect.y + cropRect.h) * displayScaleY - cropHandles.br.offsetHeight / 2) + 'px';
    }
    updateCropInputs();
}

function onCropHandleMouseDown(e) {
    e.preventDefault();
    isDraggingCropHandle = true;
    currentCropHandle = e.target.id;
    const overlayRect = cropOverlay.getBoundingClientRect();
    cropStartX = e.clientX - overlayRect.left;
    cropStartY = e.clientY - overlayRect.top;
    document.addEventListener('mousemove', onCropHandleMouseMove);
    document.addEventListener('mouseup', onCropHandleMouseUp);
}

function onCropHandleMouseMove(e) {
    if (!isDraggingCropHandle || !processedGumCanvas || !cropOverlay) return;
    e.preventDefault();

    const overlayBoundingRect = cropOverlay.getBoundingClientRect(); // Use a different name to avoid confusion
    let displayedMouseX = e.clientX - overlayBoundingRect.left;
    let displayedMouseY = e.clientY - overlayBoundingRect.top;

    // Scaling factors to convert displayed coordinates to actual canvas surface coordinates
    const scaleXToCanvas = processedGumCanvas.width / cropOverlay.offsetWidth;
    const scaleYToCanvas = processedGumCanvas.height / cropOverlay.offsetHeight;

    // Convert mouse position to actual canvas coordinates
    let canvasMouseX = displayedMouseX * scaleXToCanvas;
    let canvasMouseY = displayedMouseY * scaleYToCanvas;

    // Clamp canvasMouseX/Y to be within the actual canvas bounds
    canvasMouseX = Math.max(0, Math.min(canvasMouseX, processedGumCanvas.width));
    canvasMouseY = Math.max(0, Math.min(canvasMouseY, processedGumCanvas.height));

    let newX_canvas = cropRect.x; // cropRect stores actual canvas coordinates
    let newY_canvas = cropRect.y;
    let newW_canvas = cropRect.w;
    let newH_canvas = cropRect.h;

    if (currentCropHandle === 'cropHandleTL') {
        newW_canvas = (cropRect.x + cropRect.w) - canvasMouseX;
        newH_canvas = (cropRect.y + cropRect.h) - canvasMouseY;
        newX_canvas = canvasMouseX;
        newY_canvas = canvasMouseY;
    } else if (currentCropHandle === 'cropHandleBR') {
        newW_canvas = canvasMouseX - cropRect.x;
        newH_canvas = canvasMouseY - cropRect.y;
    }
    // Add more handles (tr, bl, t, b, l, r) for more complex resizing

    // Basic validation to prevent negative width/height or too small crop
    if (newW_canvas >= 10) { // Operate on canvas coordinates
      cropRect.x = newX_canvas;
      cropRect.w = newW_canvas;
    }
    if (newH_canvas >= 10) {
      cropRect.y = newY_canvas;
      cropRect.h = newH_canvas;
    }

    drawCropOverlay();
}

function onCropHandleMouseUp(e) {
    if (!isDraggingCropHandle) return;
    e.preventDefault();
    isDraggingCropHandle = false;
    currentCropHandle = null;
    document.removeEventListener('mousemove', onCropHandleMouseMove);
    document.removeEventListener('mouseup', onCropHandleMouseUp);
}

function setupCropOverlay() {
    if (!cropOverlay || !processedGumCanvas) return;

    // Position the cropOverlay directly over the processedGumCanvas
    // offsetTop/Left are relative to the offsetParent, which should be .video-wrapper
    cropOverlay.style.top = processedGumCanvas.offsetTop + 'px';
    cropOverlay.style.left = processedGumCanvas.offsetLeft + 'px';

    // Explicitly set cropOverlay size to match the displayed size of processedGumCanvas
    cropOverlay.style.width = processedGumCanvas.offsetWidth + 'px';
    cropOverlay.style.height = processedGumCanvas.offsetHeight + 'px';


    // Set initial cropRect to a portion of the canvas or full canvas
    cropRect.w = processedGumCanvas.width * 0.8; // Default to 80% width
    cropRect.h = processedGumCanvas.height * 0.8; // Default to 80% height
    cropRect.x = (processedGumCanvas.width - cropRect.w) / 2;
    cropRect.y = (processedGumCanvas.height - cropRect.h) / 2;

    // Clear previous handles if any
    cropOverlay.innerHTML = ''; // Clear existing content
    cropBoxElement = document.createElement('div');
    cropBoxElement.id = 'cropBox';
    cropOverlay.appendChild(cropBoxElement);

    // Create handles (simplified: top-left and bottom-right)
    const handleTL = document.createElement('div');
    handleTL.id = 'cropHandleTL';
    handleTL.className = 'crop-handle';
    handleTL.addEventListener('mousedown', onCropHandleMouseDown);
    cropOverlay.appendChild(handleTL);
    cropHandles.tl = handleTL;

    const handleBR = document.createElement('div');
    handleBR.id = 'cropHandleBR';
    handleBR.className = 'crop-handle';
    handleBR.addEventListener('mousedown', onCropHandleMouseDown);
    cropOverlay.appendChild(handleBR);
    cropHandles.br = handleBR;

    drawCropOverlay(); // Initial draw
}

// It returns true on success, false on failure (if critical elements are missing).
function initializeAppAndEventListeners() {
  console.log('Attempting to initializeAppAndEventListeners...');
  console.log('Current document.readyState:', document.readyState);
  console.log('Attempting to find canvas with ID "processedGum" via getElementById:', document.getElementById('processedGum'));
  
  errorMsgElement = document.getElementById("statusMessage"); // Use the new status element
  recordedVideo = document.querySelector("video#recorded");
  recordButton = document.querySelector("button#record");
  playButton = document.querySelector("button#play");
  applyEditsButton = document.querySelector("button#applyEdits");
  liveWidthDisplay = document.querySelector("span#liveWidth");
  liveHeightDisplay = document.querySelector("span#liveHeight");
  gumVideo = document.querySelector("video#gum");
  processedGumCanvas = document.querySelector("canvas#processedGum");
  blurToggle = document.querySelector("#blurToggle");
  blurAmountSlider = document.getElementById("blurAmountSlider");
  startButton = document.querySelector("button#start");
  cropOverlay = document.getElementById('cropOverlay');
  cropBoxElement = document.getElementById('cropBox');

  ffmpegProgressSection = document.getElementById('ffmpegProgressSection');
  ffmpegProgressBar = document.getElementById('ffmpegProgressBar');
  ffmpegProgressText = document.getElementById('ffmpegProgressText');
  ffmpegProgressTime = document.getElementById('ffmpegProgressTime');
  if (!processedGumCanvas) {
    console.error("CRITICAL ERROR: canvas#processedGum element not found in the DOM.");
    // Try to get errorMsgElement again, in case it also failed to initialize earlier or was null
    const errSpan = document.getElementById("statusMessage");
    if (errSpan) {
        updateStatus("Error: Critical UI component 'processedGum' (canvas) is missing. App cannot start.", 'error');
    }
    // Do not proceed with setting up context or event listeners if canvas is missing.
    return false; 
  }
  processedGumCtx = processedGumCanvas.getContext("2d");

  // Add a simple listener to the blur toggle for logging its state change
  if (blurToggle) {
    blurToggle.addEventListener('change', () => {
      // console.log('Blur toggle changed. New state:', blurToggle.checked); // Less verbose
      if (blurAmountSlider) {
        blurAmountSlider.disabled = !blurToggle.checked;
      }
    });
  }
  if (blurAmountSlider) {
    blurAmountSlider.addEventListener('input', () => {
      // The renderLoop will pick up the new value automatically
    });
  }

  // Add event listeners
  if (recordButton) {
    recordButton.addEventListener("click", () => {
      if (recordButton.textContent === "Record") return startRecording();
      stopRecording();
      recordButton.textContent = "Record";
      if(playButton) playButton.disabled = false;
      if(applyEditsButton) applyEditsButton.disabled = false;
    });
  }

  if (playButton) {
    playButton.addEventListener("click", () => {
      if (!recordedBlobs || recordedBlobs.length === 0) {
        updateStatus("No video recorded to play.", 'info');
        return;
      }
      const superBuffer = new Blob(recordedBlobs, { type: "video/webm" });
      recordedVideo.src = null;
      recordedVideo.srcObject = null;
      recordedVideo.src = window.URL.createObjectURL(superBuffer);
      recordedVideo.onloadedmetadata = () => {
        recordedVideo.play();
      };
      recordedVideo.controls = true;
    });
  }

  if (applyEditsButton) {
    applyEditsButton.addEventListener("click", async () => {
      if (!originalRecordedBlob || originalRecordedBlob.size === 0) {
        updateStatus("No video recorded or recording is empty.", 'info');
        return;
      }

      updateStatus("Processing video...", 'loading');
      applyEditsButton.disabled = true;
      if(playButton) playButton.disabled = true;
      
      // Show and reset progress bar
      if (ffmpegProgressSection) ffmpegProgressSection.style.display = 'block';
      if (ffmpegProgressBar) ffmpegProgressBar.style.width = '0%';
      if (ffmpegProgressText) ffmpegProgressText.textContent = '0%';
      if (ffmpegProgressTime) ffmpegProgressTime.textContent = 'Processed: 0.0s';

      let lastReportedRatio = 0; // To avoid too frequent DOM updates for text
      let inputDuration = 0; // Will try to get this if possible

      try {
        const ffmpegInstance = await loadFFmpeg();

        const t0 = document.getElementById("t0").value;
        const t1 = document.getElementById("t1").value;
        const cropXVal = document.getElementById("cropX").value;
        const cropYVal = document.getElementById("cropY").value;
        const cropWVal = document.getElementById("cropW").value;
        const cropHVal = document.getElementById("cropH").value;

        const inputFileData = await fetchFile(originalRecordedBlob);
        ffmpegInstance.FS("writeFile", "input.webm", inputFileData);

        // Attempt to get input duration (optional, for more accurate time display if ratio is not perfect)
        // This is a bit of a hack and might not always work or might be slow.
        // For now, we'll primarily rely on FFmpeg's `ratio`.
        // You could use a library like `mediainfo.js` for more robust metadata extraction.

        ffmpegInstance.setProgress(({ ratio, time }) => {
            // time is in microseconds
            const currentProgressRatio = Math.max(0, Math.min(1, ratio)); // Clamp ratio between 0 and 1
            if (ffmpegProgressBar) ffmpegProgressBar.style.width = (currentProgressRatio * 100) + '%';
            
            // Only update text content if ratio changed significantly to avoid flooding DOM updates
            if (Math.abs(currentProgressRatio - lastReportedRatio) > 0.005 || currentProgressRatio === 1) {
                if (ffmpegProgressText) ffmpegProgressText.textContent = Math.round(currentProgressRatio * 100) + '%';
                if (ffmpegProgressTime) ffmpegProgressTime.textContent = `Processed: ${(time / 1000000).toFixed(1)}s`;
                lastReportedRatio = currentProgressRatio;
            }
        });

        const command = ["-i", "input.webm"];
        if (t0 && t1 && parseFloat(t1) > parseFloat(t0)) command.push("-ss", t0, "-to", t1);
        else if (t0) command.push("-ss", t0);
        if (cropWVal && cropHVal && cropXVal && cropYVal) command.push("-vf", `crop=${cropWVal}:${cropHVal}:${cropXVal}:${cropYVal}`);
        command.push("-c:v", "libvpx-vp9", "-c:a", "libopus", "output.webm");

        await ffmpegInstance.run(...command);
        const data = ffmpegInstance.FS("readFile", "output.webm");
        const editedBlob = new Blob([data.buffer], { type: "video/webm" });

        recordedVideo.src = null;
        recordedVideo.srcObject = null;
        recordedVideo.src = URL.createObjectURL(editedBlob);
        recordedVideo.controls = true;
        recordedVideo.onloadedmetadata = () => {
          recordedVideo.play();
          updateStatus("Edits applied. Playing edited video.", 'success');
        };
      } catch (e) {
        console.error("Error during FFmpeg processing:", e);
        updateStatus(`Error processing video: ${e.toString()}. Progress might be inaccurate.`, 'error');
      } finally {
        applyEditsButton.disabled = false;
        if(playButton) playButton.disabled = false;
        // Optionally hide progress bar after a short delay or keep it visible with final status
        // if (ffmpegProgressSection) ffmpegProgressSection.style.display = 'none'; 
      }
    });
  }

  if (startButton) {
    startButton.addEventListener("click", async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        if(recordButton) recordButton.disabled = false;
        if(playButton) playButton.disabled = true;
        if(applyEditsButton) applyEditsButton.disabled = true;
        window.stream = stream;
        // gumVideo is already assigned from querySelector above
        if (gumVideo) {
          gumVideo.srcObject = stream;
          if(blurToggle) { blurToggle.disabled = true; if(blurAmountSlider) blurAmountSlider.disabled = true; } // Disable while loading

          // Use onloadedmetadata primarily to get initial dimensions
          gumVideo.onloadedmetadata = () => {
            console.log(`onloadedmetadata: gumVideo.videoWidth=${gumVideo.videoWidth}, gumVideo.videoHeight=${gumVideo.videoHeight}`);
            if (gumVideo.videoWidth > 0 && gumVideo.videoHeight > 0) {
              if(liveWidthDisplay) liveWidthDisplay.textContent = gumVideo.videoWidth;
              if(liveHeightDisplay) liveHeightDisplay.textContent = gumVideo.videoHeight;
              if(processedGumCanvas) {
                processedGumCanvas.width = gumVideo.videoWidth;
                processedGumCanvas.height = gumVideo.videoHeight;
                console.log(`processedGumCanvas dimensions set via onloadedmetadata to: ${processedGumCanvas.width}x${processedGumCanvas.height}`);
              }
            } else {
              console.error("onloadedmetadata: gumVideo dimensions are zero or invalid.");
              updateStatus("Error: Camera started but video dimensions are initially invalid.", 'error');
            }
          };

          // Use onplaying as the trigger to start BodyPix and the render loop
          gumVideo.onplaying = async () => {
            console.log(`onplaying: gumVideo is now playing. Dimensions: ${gumVideo.videoWidth}x${gumVideo.videoHeight}`);
            // Double-check and set canvas dimensions again if needed, ensuring they are valid
            if (gumVideo.videoWidth > 0 && gumVideo.videoHeight > 0 && processedGumCanvas) {
              processedGumCanvas.width = gumVideo.videoWidth;
              processedGumCanvas.height = gumVideo.videoHeight;
            } else if (processedGumCanvas.width === 0 || processedGumCanvas.height === 0) {
              console.error("onplaying: gumVideo or processedGumCanvas dimensions are still zero. Cannot start render loop.");
              updateStatus("Error: Video playing but dimensions are invalid for processing.", 'error');
              return;
            }
            
            if (animationFrameId) cancelAnimationFrame(animationFrameId); // Clear any old loop
            await loadBodyPixModel(); // Load the model
            setupCropOverlay(); // Initialize the crop overlay now that canvas has dimensions
            renderLoop(); // Start the processing loop
          };

          await gumVideo.play().catch(e => { // Start playing the video
            console.error("Error trying to play gumVideo:", e);
            updateStatus(`Error starting video playback: ${e.toString()}`, 'error');
          });
        }
      } catch (e) {
        console.error("navigator.getUserMedia error:", e);
        if(errorMsgElement) errorMsgElement.innerHTML = `navigator.getUserMedia error:${e.toString()}`;
      }
    });
  }
  console.log('initializeAppAndEventListeners: Successfully initialized elements and event listeners.');
  return true; // Indicate success
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded event fired.');
  updateStatus("Initializing application...", 'info');
  console.log('Document readyState on DOMContentLoaded:', document.readyState);

  if (!initializeAppAndEventListeners()) {
    console.warn('Initial app initialization failed on DOMContentLoaded. Retrying after a short delay (200ms)...');
    setTimeout(() => {
      if (!initializeAppAndEventListeners()) {
        console.error('FATAL: App initialization failed even after timeout. The canvas element seems persistently unavailable.');
        updateStatus('FATAL: App initialization failed. Please refresh.', 'error');
        // errorMsgElement might still be null here if the first attempt failed to find it.
      }
    }, 200); // Wait 200ms and try again
  }
});