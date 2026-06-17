"use client";

import { useState, useRef, useEffect } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";

interface Props {
  value: string;
  onChange: (code: string) => void;
  label?: string;
  searchPlaceholder?: string;
}

export default function LanguagePicker({
  value,
  onChange,
  label = "Choose your language",
  searchPlaceholder = "Search languages...",
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = SUPPORTED_LANGUAGES.find((l) => l.code === value);

  const filtered = SUPPORTED_LANGUAGES.filter(
    (l) =>
      l.nativeName.toLowerCase().includes(search.toLowerCase()) ||
      l.name.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      {label && (
        <label className="mb-2 block text-sm font-semibold uppercase tracking-wide text-text-muted">
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-[13px] border border-border bg-surface px-4 py-3 text-left text-lg font-medium text-text transition-colors hover:border-secondary focus:border-secondary focus:outline-none"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-3">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-text-muted"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9s1.3-6.5 3.8-9z" />
          </svg>
          <span>{selected?.nativeName ?? "Select language"}</span>
          {selected && selected.code !== "en" && (
            <span className="text-sm text-text-faint">({selected.name})</span>
          )}
        </span>
        <span className="text-text-faint">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-[13px] border border-border bg-surface shadow-lg">
          <div className="border-b border-border p-3">
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm text-text focus:border-secondary focus:outline-none"
            />
          </div>
          <ul
            role="listbox"
            className="max-h-64 overflow-y-auto"
          >
            {filtered.length === 0 && (
              <li className="px-4 py-3 text-sm text-text-faint">No languages found</li>
            )}
            {filtered.map((lang) => (
              <li
                key={lang.code}
                role="option"
                aria-selected={lang.code === value}
                onClick={() => {
                  onChange(lang.code);
                  setOpen(false);
                  setSearch("");
                }}
                className={`flex cursor-pointer items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-harbor-50 ${
                  lang.code === value ? "bg-harbor-50 font-semibold text-harbor-700" : "text-text"
                }`}
              >
                <span className="min-w-0 flex-1 font-medium">{lang.nativeName}</span>
                {lang.name !== lang.nativeName && (
                  <span className="text-text-faint">{lang.name}</span>
                )}
                {lang.code === value && (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-secondary"
                    aria-hidden="true"
                  >
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
