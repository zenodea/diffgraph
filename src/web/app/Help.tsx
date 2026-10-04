import { useEffect, useState } from "preact/hooks";
import { useKeys } from "../lib/hooks.ts";

/** What the map's marks mean and the keys, on demand instead of a permanent legend. */
export function Help({ reviewMode }: { reviewMode: boolean }) {
  const [open, setOpen] = useState(false);
  useKeys((e) => {
    if (e.key === "?") setOpen(!open);
    else if (e.key === "Escape" && open) setOpen(false);
    else return;
    e.preventDefault();
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !(e.target as Element).closest(".help") && setOpen(false);
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div class="help">
      <button class="btn help-btn" aria-expanded={open} onClick={() => setOpen(!open)} title="What things mean (?)">
        ?
      </button>
      {open && (
        <div class="help-pop" role="dialog" aria-label="Help">
          <h3>On the map</h3>
          <ul>
            <li><i class="ld s-A" />added <i class="ld s-M" />modified <i class="ld s-D" />deleted <i class="ld s-R" />renamed</li>
            <li><i class="ld pie" />how much of the file changed</li>
            <li><i class="ld thick" />thicker branch: more changed down there</li>
            <li><i class="ld ghost" />with Imports on: unchanged, but uses a changed file</li>
            <li><span class="news-tag">new</span> appeared or changed since you last looked</li>
            {reviewMode && <li><i class="ld done" />reviewed · <i class="ld again" />edited again since</li>}
          </ul>
          <h3>Moving around</h3>
          <div class="keys">
            <span>scroll / drag</span><span>pan</span>
            <span>pinch, ⌘ scroll</span><span>zoom</span>
            <span><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd></span><span>zoom in, out, fit</span>
          </div>
          <h3>Keys</h3>
          <div class="keys">
            <span><kbd>g</kbd></span><span>map ⇄ files</span>
            <span><kbd>j</kbd> <kbd>k</kbd> · <kbd>enter</kbd></span><span>select · open</span>
            <span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span><span>unified, split, full file</span>
            <span><kbd>a</kbd></span><span>ask about the selection</span>
            <span><kbd>r</kbd></span><span>review mode</span>
            {reviewMode && (
              <>
                <span><kbd>space</kbd> · <kbd>n</kbd> · <kbd>h</kbd></span><span>reviewed · next · hide reviewed</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
