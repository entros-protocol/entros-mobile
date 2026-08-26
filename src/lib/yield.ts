/**
 * Cooperative yield to the host environment's event loop.
 *
 * Heavy synchronous work in feature extraction (F0 detection, HNR
 * autocorrelation, LPC formant analysis, Meyda spectral) blocks the
 * JS thread for tens to hundreds of milliseconds on a single tight
 * loop. The verify UI sets a "Extracting features..." stage label but
 * the spinner can't repaint while the thread is busy.
 *
 * Calling `await yieldToMainThread()` between heavy stages hands control
 * back to the host event loop long enough for the renderer to flush a
 * frame, then resumes. `MessageChannel` is the lowest-overhead path on
 * platforms that support it; Hermes / React Native fall through to
 * `setTimeout(fn, 0)` (natively implemented, no 4ms throttle).
 *
 * Mirrors `pulse-sdk/src/yield.ts` byte-for-byte (modulo the doc
 * paragraph above) so the cross-platform reproducibility guarantee
 * called out in `extraction/speaker.ts` continues to hold.
 */
export function yieldToMainThread(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof MessageChannel !== "undefined") {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
      return;
    }
    if (typeof setTimeout !== "undefined") {
      setTimeout(resolve, 0);
      return;
    }
    resolve();
  });
}
