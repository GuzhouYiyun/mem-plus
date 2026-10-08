import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "$lib/utils";

/**
 * A listbox the page draws itself.
 *
 * This exists because a native `<select>` cannot be styled where it matters: the
 * **popup** is rendered by the operating system, with the system font and system
 * colours, and no stylesheet reaches it. A closed control can be made to match the
 * page; the list you actually read cannot. So every dropdown in the config form
 * uses this instead -- the short enumerations (three of them) and the 58-model
 * picker alike, so they look like one control rather than two.
 *
 * What the native one gave us for free, and what this has to earn:
 *   - the popup looks like the rest of the page (the original complaint)
 *   - a filter box, because the model list is long and nothing else lets you type
 *   - arrow keys / Enter / Escape / Tab, and `role="listbox"` so a screen reader
 *     announces the selection instead of "combo box"
 */

export type PickerOption = {
  value: string;
  label: string;
  /**
   * A translation of `label`, shown right after it in muted text.
   *
   * The identifier stays the primary text on purpose. It is what goes in the
   * config file and what the plugin's reader matches on, so it is what you want
   * in front of you; the Chinese is there to say what it means. Brightening the
   * translation instead made `自动` the headline while `discrete` -- which has no
   * translation -- was itself the headline, so the rows did not even agree on
   * which part was important.
   */
  sublabel?: string;
  /**
   * Right-aligned secondary text, e.g. the `provider/model` behind a name.
   *
   * Capped at a share of the row and allowed to truncate. It was `shrink-0`
   * before, which meant it could never give ground: with a long display name on
   * the left and `provider/model` on the right, the label collapsed to `a…` and
   * the secondary text kept its full width. The label is what you are choosing
   * between, so it is the one that gets the room.
   */
  hint?: string;
  disabled?: boolean;
  /** Heading this option sits under. Options are grouped by it, in first-seen order. */
  group?: string;
};

type Props = {
  id?: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Show a filter box. Worth it past about six options. */
  searchable?: boolean;
  /** Offer an empty value as a real choice (the "follow the default" entry). */
  emptyLabel?: string;
  /** What the closed control shows when nothing matches / no value is set. */
  placeholder?: string;
  /** Shown when the filter matches nothing. */
  emptyResult?: string;
  className?: string;
};

export function Picker({
  id,
  value,
  options,
  onChange,
  disabled,
  searchable = false,
  emptyLabel,
  placeholder,
  emptyResult,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchId = useId();

  // The empty entry is a real choice, so it takes part in filtering and movement.
  const entries = useMemo(
    () => (emptyLabel === undefined ? [...options] : [{ value: "", label: emptyLabel }, ...options]),
    [options, emptyLabel]
  );

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle.length === 0
        ? entries
        : entries.filter(
            (o) => o.label.toLowerCase().includes(needle) || (o.hint ?? "").toLowerCase().includes(needle)
          ),
    [entries, needle]
  );

  // Grouped only while browsing; with a filter you are after one string, and the
  // headings would just be noise between you and it.
  const groups = useMemo(() => {
    if (needle.length > 0) return [{ group: undefined as string | undefined, options: matches }];
    const order: string[] = [];
    const byGroup = new Map<string, PickerOption[]>();
    for (const option of matches) {
      const key = option.group ?? "";
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        order.push(key);
      }
      (byGroup.get(key) as PickerOption[]).push(option);
    }
    return order.map((group) => ({ group: group || undefined, options: byGroup.get(group) as PickerOption[] }));
  }, [matches, needle]);

  const selected = entries.find((o) => o.value === value);
  const selectedKnown = selected !== undefined;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    // Start on the current value, so Enter without moving re-picks it rather than
    // jumping to the top of the list.
    const index = matches.findIndex((o) => o.value === value);
    setActive(index >= 0 ? index : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open, groups]);

  function move(step: number) {
    if (matches.length === 0) return;
    setActive((previous) => (previous + step + matches.length) % matches.length);
  }

  function pick(option: PickerOption) {
    onChange(option.value);
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div className={cn("relative", className)} ref={root}>
      <button
        id={id}
        ref={button}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? `${searchId}-list` : undefined}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
            return;
          }
          if (!open) return;
          if (event.key === "ArrowDown") move(1);
          else if (event.key === "ArrowUp") move(-1);
          else if (event.key === "Enter") {
            event.preventDefault();
            const option = matches[active];
            if (option && !option.disabled) pick(option);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            button.current?.focus();
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
        className={cn(
          "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/30 flex h-8 w-full items-center gap-2 rounded-lg border bg-transparent px-2.5 text-start text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-3",
          open && "border-ring ring-ring/30 ring-3"
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !selectedKnown && "text-muted-foreground")}>
          {selectedKnown ? selected?.label : (placeholder ?? (value || "—"))}
          {selectedKnown && selected?.sublabel ? (
            <span className="ms-1.5 text-muted-foreground">{selected.sublabel}</span>
          ) : null}
        </span>
        {selectedKnown && selected?.hint ? (
          <span className="min-w-0 max-w-[45%] truncate text-sm text-muted-foreground">{selected.hint}</span>
        ) : null}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full min-w-40 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          {searchable ? (
            <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                id={searchId}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholder}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}

          <div ref={list} id={`${searchId}-list`} role="listbox" className="max-h-[26rem] overflow-y-auto py-1">
            {matches.length === 0 ? (
              <p className="px-2.5 py-3 text-sm text-muted-foreground">{emptyResult ?? placeholder}</p>
            ) : (
              groups.map((group) => (
                <div key={group.group ?? "*"}>
                  {group.group ? (
                    <div className="px-2.5 pt-2 pb-1 text-sm text-muted-foreground">{group.group}</div>
                  ) : null}
                  {group.options.map((option) => {
                    const index = matches.indexOf(option);
                    const isActive = index === active;
                    const isSelected = option.value === value;
                    return (
                      <button
                        key={option.value || "(empty)"}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={option.disabled || undefined}
                        data-active={isActive ? "true" : undefined}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => (option.disabled ? undefined : pick(option))}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-2 text-start text-sm",
                          // Two different rows get two different marks. The selected
                          // one is stronger, and the active one is only the hover /
                          // keyboard cursor -- with the tick gone they would
                          // otherwise both be a faint wash and the current value
                          // would be invisible until you moved the mouse.
                          isSelected && "bg-accent text-accent-foreground",
                          isActive && !isSelected && !option.disabled && "bg-muted",
                          option.disabled && "cursor-not-allowed text-muted-foreground opacity-60"
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {option.label}
                          {option.sublabel ? (
                            <span className="ms-1.5 text-muted-foreground">{option.sublabel}</span>
                          ) : null}
                        </span>
                        {option.hint ? (
                          <span className="min-w-0 max-w-[45%] truncate text-sm text-muted-foreground">{option.hint}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}