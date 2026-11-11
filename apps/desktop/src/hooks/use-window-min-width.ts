import { useEffect } from "react";
import { setWindowMinSize } from "@/lib/tauri";
import { WINDOW_MIN_HEIGHT } from "@/lib/window-min-width";

export function useWindowMinWidth(width: number) {
  useEffect(() => {
    setWindowMinSize(width, WINDOW_MIN_HEIGHT).catch((error) =>
      console.error("[window] Could not set the minimum window size", error),
    );
  }, [width]);
}
