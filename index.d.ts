export interface GuiOptions {
  /** Initial window width in pixels. */
  width: number;
  /** Initial window height in pixels. */
  height: number;
  /** Localhost port to navigate to (1–65535). */
  port: number;
  /** Callback invoked when the window is closed. */
  onClose?: () => void;
}

export interface GuiHandle {
  /** Close the native window. Safe to call multiple times. */
  close(): void;
}

/**
 * Open a native window with an embedded browser control pointing to
 * `http://localhost:<port>`.
 */
export function open(options: GuiOptions): GuiHandle;
