"use client";

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeChoice } from "@/lib/theme";
import { applyTheme } from "@/lib/theme/apply";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * Light / dark / system, in the top bar. The server already set `data-theme` before first paint
 * from the same cookie, so this only changes it on a click: attribute now, cookie for next load.
 */
export function ThemeToggle({ initial }: { initial: ThemeChoice }) {
  const [theme, setTheme] = useState<ThemeChoice>(initial);

  function choose(next: ThemeChoice) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="border-border bg-muted/60 inline-flex items-center gap-0.5 rounded-full border p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            data-theme-choice={value}
            onClick={() => choose(value)}
            className={cn(
              "focus-visible:ring-ring flex size-6 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none",
              selected
                ? "bg-accent-gradient text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
