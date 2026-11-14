import { useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Camera, CheckCircle2, CircleAlert, LoaderCircle, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        sendData: (data: string) => void;
        close: () => void;
        HapticFeedback?: { notificationOccurred: (type: "success" | "warning" | "error") => void };
      };
    };
  }
}

export const Route = createFileRoute("/scan")({
  head: () => ({
    meta: [
      { title: "Scan Barcode | STOREMAX POS" },
      { name: "description", content: "Scan a STOREMAX product barcode and add it to a new sale." },
      { property: "og:title", content: "Scan Barcode | STOREMAX POS" },
      { property: "og:description", content: "Scan a product barcode to continue a STOREMAX sale." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BarcodeScanner,
});

type ScannerControls = { stop: () => void };
type CameraState = "idle" | "starting" | "scanning" | "sent";

function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const sentRef = useRef(false);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState("");
  const [isTelegram, setIsTelegram] = useState(false);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (webApp) {
      webApp.ready();
      webApp.expand();
      setIsTelegram(true);
    }
    return () => stopCamera();
  }, []);

  function stopCamera() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function sendBarcode(value: string) {
    const code = value.trim();
    if (!code || code.length > 128) {
      setError("Enter a barcode up to 128 characters.");
      return;
    }
    setBarcode(code);
    setError("");
    sentRef.current = true;
    stopCamera();
    const webApp = window.Telegram?.WebApp;
    if (webApp) {
      try {
        webApp.HapticFeedback?.notificationOccurred("success");
        webApp.sendData(JSON.stringify({ type: "storemax_scan", barcode: code }));
        setCameraState("sent");
        webApp.close();
      } catch {
        setError("Telegram couldn't send this scan. Reopen the scanner from New Sale and try again.");
        sentRef.current = false;
      }
      return;
    }
    setCameraState("sent");
    setError("Code captured. Open this scanner from the Telegram New Sale screen to send it to your cart.");
  }

  async function startCamera() {
    setError("");
    sentRef.current = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera access needs a secure HTTPS page. Open the scanner from the STOREMAX Telegram bot.");
      return;
    }
    setCameraState("starting");
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      if (!videoRef.current) throw new Error("Camera preview is unavailable.");
      controlsRef.current = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current,
        (result, decodeError) => {
          if (result && !sentRef.current) sendBarcode(result.getText());
          else if (decodeError && decodeError.name !== "NotFoundException" && !sentRef.current) {
            setError("The camera couldn't read this barcode. Hold the code steady in the frame or enter it below.");
          }
        },
      );
      setCameraState("scanning");
    } catch (cause) {
      stopCamera();
      setCameraState("idle");
      const name = cause instanceof Error ? cause.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setError("Camera access is blocked. Allow camera access for this site in iPhone Settings, then try again.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found. Enter the barcode manually to continue.");
      } else {
        setError("The camera couldn't start. Check camera permission and try again, or enter the barcode manually.");
      }
    }
  }

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendBarcode(barcode);
  }

  return (
    <main className="min-h-[100svh] bg-background text-foreground">
      <div className="mx-auto flex min-h-[100svh] w-full max-w-xl flex-col px-5 pb-8 pt-5">
        <header className="flex items-center gap-3 border-b border-border pb-4">
          <a href="/" aria-label="STOREMAX home" className="inline-flex size-10 items-center justify-center rounded-md border border-border text-muted-foreground">
            <ArrowLeft className="size-5" aria-hidden="true" />
          </a>
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">STOREMAX LIMITED</p>
            <h1 className="text-xl font-semibold">Scan item</h1>
          </div>
        </header>

        <section className="flex flex-1 flex-col gap-5 py-5">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-muted">
            <video
              ref={videoRef}
              className="absolute inset-0 size-full object-cover"
              aria-label="Barcode camera preview"
              autoPlay
              muted
              playsInline
            />
            {cameraState !== "scanning" && cameraState !== "starting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted text-muted-foreground">
                {cameraState === "sent" ? <CheckCircle2 className="size-10 text-primary" /> : <ScanLine className="size-10" />}
                <span className="text-sm">{cameraState === "sent" ? "Barcode captured" : "Camera preview"}</span>
              </div>
            )}
            {(cameraState === "scanning" || cameraState === "starting") && (
              <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-28 -translate-y-1/2 rounded-md border-2 border-primary" aria-hidden="true" />
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {cameraState === "scanning" ? "Point the rear camera at a product barcode." : "Use your iPhone camera or enter the code manually."}
            </p>
            {cameraState === "scanning" ? (
              <Button type="button" variant="outline" onClick={() => { stopCamera(); setCameraState("idle"); }}>
                Stop
              </Button>
            ) : (
              <Button type="button" onClick={() => void startCamera()} disabled={cameraState === "starting" || cameraState === "sent"}>
                {cameraState === "starting" ? <LoaderCircle className="animate-spin" /> : <Camera />}
                {cameraState === "starting" ? "Starting" : "Open camera"}
              </Button>
            )}
          </div>

          <div className="border-t border-border pt-5">
            <div className="mb-3 flex items-center gap-2">
              <ScanLine className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Barcode</h2>
            </div>
            <form onSubmit={submitManual} className="flex gap-2">
              <Input
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                inputMode="text"
                autoComplete="off"
                placeholder="Type barcode or SKU"
                aria-label="Barcode or SKU"
                maxLength={128}
              />
              <Button type="submit" disabled={!barcode.trim() || cameraState === "sent"}>Add</Button>
            </form>
          </div>

          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
          {!isTelegram && <p className="text-xs text-muted-foreground">Open this page from New Sale in the STOREMAX Telegram bot to send a scan to your sale.</p>}
        </section>
      </div>
    </main>
  );
}