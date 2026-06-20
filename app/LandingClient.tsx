"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";
import LanguagePicker from "@/components/LanguagePicker";
import { SUPPORTED_LANGUAGES } from "@/lib/languages";
import enStrings from "@/locales/en.json";

type Landing = typeof enStrings.landing;
const EN: Landing = enStrings.landing;

/* Right-to-left scripts among the supported languages */
const RTL = new Set(["ar", "fa", "ps", "ur"]);

/* ----------------------------------------------------------------
   Topographic ridgelines — deterministic SVG paths drawn across
   double width (2 × 1440) so a -1440px translate loops seamlessly.
   Ported from the "Wayfinder Landing A — Horizon" design.
----------------------------------------------------------------- */
type Ridge = { d: string; fill: string; op: number; dur: number };

function buildRidges(
  H: number,
  step: number,
  configs: { baseY: number; amp: number[]; freq: number[]; phase: number[]; fill: string; op: number; dur: number }[]
): Ridge[] {
  const W = 1440;
  const span = 2 * W;
  return configs.map((c) => {
    const pts: [number, number][] = [];
    for (let x = 0; x <= span; x += step) {
      let y = c.baseY;
      for (let i = 0; i < c.amp.length; i++) {
        y += c.amp[i] * Math.sin((x / W) * Math.PI * 2 * c.freq[i] + c.phase[i]);
      }
      pts.push([x, y]);
    }
    let d = `M0,${H} L0,${pts[0][1].toFixed(1)} `;
    for (const [x, y] of pts) d += `L${x},${y.toFixed(1)} `;
    d += `L${span},${H} Z`;
    return { d, fill: c.fill, op: c.op, dur: c.dur };
  });
}

const HERO_RIDGES = buildRidges(600, 10, [
  { baseY: 248, amp: [34, 14, 7], freq: [2, 3, 5], phase: [0.4, 1.2, 2.7], fill: "#ECC99E", op: 0.95, dur: 150 },
  { baseY: 300, amp: [40, 16, 8], freq: [2, 4, 6], phase: [1.4, 0.6, 3.1], fill: "#D2BE97", op: 1, dur: 128 },
  { baseY: 352, amp: [46, 18, 9], freq: [2, 3, 4], phase: [2.1, 1.9, 0.7], fill: "#A6BC8F", op: 1, dur: 108 },
  { baseY: 408, amp: [52, 20, 10], freq: [1, 3, 5], phase: [0.9, 2.7, 1.5], fill: "#6E9C76", op: 1, dur: 88 },
  { baseY: 466, amp: [58, 22, 11], freq: [2, 3, 5], phase: [2.6, 0.3, 2.2], fill: "#467E5A", op: 1, dur: 70 },
  { baseY: 528, amp: [64, 24, 12], freq: [1, 2, 4], phase: [1.7, 2.1, 0.5], fill: "#2C5E45", op: 1, dur: 54 },
]);

const FOOT_RIDGES = buildRidges(300, 12, [
  { baseY: 150, amp: [30, 12], freq: [2, 4], phase: [0.6, 1.8], fill: "#A6BC8F", op: 1, dur: 120 },
  { baseY: 200, amp: [38, 15], freq: [1, 3], phase: [2.0, 0.9], fill: "#5E9070", op: 1, dur: 96 },
  { baseY: 252, amp: [44, 18], freq: [2, 3], phase: [1.3, 2.4], fill: "#2C5E45", op: 1, dur: 72 },
]);

/* Topographic contour rings for the dark "trust" panel */
function buildRings(): string[] {
  const cx = 430, cy = 195, rings: string[] = [];
  for (let k = 0; k < 7; k++) {
    const r = 40 + k * 46;
    let d = "";
    for (let a = 0; a <= 360; a += 8) {
      const rad = (a * Math.PI) / 180;
      const wob = 1 + 0.1 * Math.sin(rad * 3 + k * 0.7) + 0.06 * Math.sin(rad * 5 + k);
      const x = cx + r * 1.18 * Math.cos(rad) * wob;
      const y = cy + r * Math.sin(rad) * wob;
      d += (a === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    }
    rings.push(d + "Z");
  }
  return rings;
}
const TRUST_RINGS = buildRings();

const QUICK_LANGS = SUPPORTED_LANGUAGES.slice(0, 6);
const MARQUEE_LANGS = SUPPORTED_LANGUAGES.slice(0, 16);

/* Visual styling only — copy comes from the translated strings */
const STEP_STYLES = [
  { bg: "#F2C892", fg: "#3A2C12" },
  { bg: "#79B98C", fg: "#16291D" },
  { bg: "#F2C892", fg: "#3A2C12" },
];

const FEATURE_STYLES: { grad: string; icon: React.ReactNode }[] = [
  {
    grad: "linear-gradient(135deg,#F4C778,#E0934A)",
    icon: (
      <>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </>
    ),
  },
  {
    grad: "linear-gradient(135deg,#79B98C,#3C7A5A)",
    icon: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </>
    ),
  },
  {
    grad: "linear-gradient(135deg,#F4C778,#E0934A)",
    icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  },
  {
    grad: "linear-gradient(135deg,#79B98C,#3C7A5A)",
    icon: (
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
];

const ARROW = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#241A0C" strokeWidth="2.4">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export default function LandingClient({ authed = false }: { authed?: boolean }) {
  const [language, setLanguage] = useState("en");
  const [t, setT] = useState<Landing>(EN);
  const [translating, setTranslating] = useState(false);
  const router = useRouter();
  const accent = "#E8A24A";

  // Per-language client cache + a guard so a slow earlier request can't clobber
  // a newer selection.
  const cacheRef = useRef<Record<string, Landing>>({ en: EN });
  const latestRef = useRef("en");

  async function changeLanguage(code: string) {
    setLanguage(code);
    latestRef.current = code;

    // Reflect language + direction on the document immediately.
    if (typeof document !== "undefined") {
      document.documentElement.lang = code;
      document.documentElement.dir = RTL.has(code) ? "rtl" : "ltr";
    }

    const cached = cacheRef.current[code];
    if (cached) {
      setTranslating(false);
      setT(cached);
      return;
    }

    setTranslating(true);
    try {
      const res = await fetch(`/api/translate?lang=${encodeURIComponent(code)}`);
      const data = await res.json();
      const next: Landing | undefined = data?.translations?.landing;
      if (res.ok && next) {
        cacheRef.current[code] = next;
        if (latestRef.current === code) setT(next); // ignore stale responses
      }
    } catch {
      /* keep current strings on failure */
    } finally {
      if (latestRef.current === code) setTranslating(false);
    }
  }

  // Already-signed-in visitors must not be dropped back into the sign-up /
  // onboarding flow. Send them to the dashboard, which itself routes to
  // onboarding only when their profile is incomplete. Everyone else creates an
  // account first (Get Started → sign up → onboarding).
  function start() {
    router.push(authed ? "/dashboard" : `/auth/signup?lang=${language}`);
  }

  const rtl = RTL.has(language);

  return (
    <main className="flex min-h-screen flex-col overflow-x-hidden" dir={rtl ? "rtl" : "ltr"}>
      {/* Translating indicator */}
      {translating && (
        <div className="fixed left-1/2 top-[84px] z-[60] -translate-x-1/2">
          <div className="flex items-center gap-2.5 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-[#FBF6EE] shadow-lg">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#FBF6EE]/40 border-t-[#FBF6EE]" />
            {t.translating}
          </div>
        </div>
      )}

      {/* ===== Nav ===== */}
      <nav
        className="fixed inset-x-0 top-0 z-50 flex items-center justify-between px-5 py-4 md:px-10 md:py-[22px]"
        style={{ backdropFilter: "blur(8px)", background: "linear-gradient(180deg,rgba(251,246,238,0.7),rgba(251,246,238,0))" }}
      >
        <a href="#top" className="flex items-center gap-[11px] focus-visible:outline-none">
          <Logo size={30} />
          <span className="text-xl font-extrabold tracking-[-0.02em] text-ink">Wayfinder</span>
        </a>
        <div className="flex items-center gap-5 md:gap-[34px]">
          <a href="#how" className="hidden text-[15.5px] font-medium text-[#46544B] hover:text-ink md:inline">{t.nav.howItWorks}</a>
          <a href="#features" className="hidden text-[15.5px] font-medium text-[#46544B] hover:text-ink md:inline">{t.nav.features}</a>
          <a href="#languages" className="hidden text-[15.5px] font-medium text-[#46544B] hover:text-ink md:inline">{t.nav.languages}</a>
          <a href="/auth/login" className="hidden text-[15.5px] font-medium text-[#46544B] hover:text-ink sm:inline">{t.nav.signIn}</a>
          <button
            onClick={start}
            className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-[11px] text-[15px] font-semibold text-[#FBF6EE] transition hover:opacity-90 active:scale-[0.98] focus-visible:outline-none"
          >
            {t.nav.getStarted}
          </button>
        </div>
      </nav>

      {/* ===== Hero ===== */}
      <section
        id="top"
        className="relative flex min-h-screen flex-col overflow-hidden"
        style={{ background: "linear-gradient(180deg,#DADDEC 0%,#E7DBE0 26%,#F3D8B9 58%,#FAE7C6 84%,#FBEBCF 100%)" }}
      >
        {/* sun glow + disc */}
        <div
          className="pointer-events-none absolute z-[1] h-[420px] w-[420px] rounded-full"
          style={{ left: "75%", top: "49%", transform: "translate(-50%,-50%)", background: "radial-gradient(circle,#FFE6B0 0%,rgba(255,222,160,0.55) 38%,rgba(255,222,160,0) 70%)", animation: "wf-glow 7s ease-in-out infinite" }}
        />
        <div
          className="pointer-events-none absolute z-[1] h-28 w-28 rounded-full"
          style={{ left: "75%", top: "49%", transform: "translate(-50%,-50%)", background: "radial-gradient(circle at 50% 40%,#FFF3D6,#F6C878)", boxShadow: "0 0 60px rgba(246,200,120,.7)" }}
        />

        {/* rolling ridgelines */}
        <svg viewBox="0 0 1440 600" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-0 bottom-0 z-[2] h-[62%] w-full">
          {HERO_RIDGES.map((r, i) => (
            <g key={i} style={{ animation: `wf-roll ${r.dur}s linear infinite`, willChange: "transform" }}>
              <path d={r.d} fill={r.fill} opacity={r.op} />
            </g>
          ))}
        </svg>

        {/* hero content */}
        <div className="relative z-[5] mx-auto flex max-w-[1240px] flex-1 flex-col items-center justify-center px-5 pb-[8vh] pt-[124px] text-center md:px-10">
          <h1 className="font-display max-w-[18ch] text-[clamp(40px,7.6vw,96px)] font-extrabold leading-[1.0] tracking-[-0.04em] text-[#1A271F]" style={{ textWrap: "balance" }}>
            {t.hero.headline}
          </h1>
          <p className="mt-[26px] max-w-[60ch] text-[clamp(17px,2vw,21px)] leading-[1.55] text-[#3C4A40]" style={{ textWrap: "pretty" }}>
            {t.hero.subheadline}
          </p>

          {/* language card */}
          <div
            className="mt-9 w-full max-w-[520px] rounded-[22px] p-[18px] text-left"
            style={{ background: "rgba(255,255,255,0.72)", border: "1px solid rgba(255,255,255,0.9)", backdropFilter: "blur(14px)", boxShadow: "0 24px 60px -22px rgba(60,50,30,.4),0 2px 0 rgba(255,255,255,.6) inset" }}
            dir={rtl ? "rtl" : "ltr"}
          >
            <div className="px-1 pb-3 pt-0.5 text-[12.5px] font-bold uppercase tracking-[0.06em] text-[#8A6E45]">
              {t.hero.cardLabel}
            </div>
            <LanguagePicker value={language} onChange={changeLanguage} label="" searchPlaceholder={t.hero.searchPlaceholder} />
            <div className="mt-[13px] flex flex-wrap gap-2">
              {QUICK_LANGS.map((l) => {
                const active = l.code === language;
                return (
                  <button
                    key={l.code}
                    onClick={() => changeLanguage(l.code)}
                    className="flex flex-col gap-px rounded-[11px] px-[14px] py-[9px] text-left transition active:scale-[0.98] focus-visible:outline-none"
                    style={{
                      background: active ? "#FBE8C9" : "#FBF4E8",
                      border: `1px solid ${active ? "#E8A24A" : "#F0E6D4"}`,
                    }}
                  >
                    <span className="text-[15px] font-bold text-[#2A3A30]">{l.nativeName}</span>
                    <span className="text-[11.5px] text-[#9A8463]">{l.name}</span>
                  </button>
                );
              })}
            </div>
            <button
              onClick={start}
              className="mt-[15px] flex w-full items-center justify-center gap-[9px] rounded-[13px] p-[15px] text-[16.5px] font-bold text-[#241A0C] transition hover:brightness-[1.03] active:scale-[0.99] focus-visible:outline-none"
              style={{ background: accent, boxShadow: "0 10px 26px -8px rgba(224,147,74,.6)" }}
            >
              {t.hero.cta}
              {ARROW}
            </button>
          </div>
        </div>
      </section>

      {/* ===== How it works ===== */}
      <section id="how" className="mx-auto max-w-[1180px] px-5 pb-[110px] pt-[110px] md:px-10 md:pt-[120px]">
        <div className="mb-16">
          <div className="mb-[14px] text-[13px] font-bold uppercase tracking-[0.1em] text-eyebrow">{t.how.eyebrow}</div>
          <h2 className="font-display max-w-[16ch] text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#1A271F]" style={{ textWrap: "balance" }}>
            {t.how.title}
          </h2>
        </div>
        <div className="relative grid grid-cols-1 gap-12 sm:grid-cols-3 sm:gap-0">
          <div className="absolute left-[9%] right-[9%] top-[27px] hidden h-0.5 sm:block" style={{ background: "repeating-linear-gradient(90deg,#D8C29A 0 9px,transparent 9px 17px)" }} />
          {t.how.steps.map((s, i) => (
            <div key={i} className={`relative ${i < t.how.steps.length - 1 ? "sm:pr-[34px]" : ""}`}>
              <div
                className="relative z-[2] mb-[26px] flex h-[54px] w-[54px] items-center justify-center rounded-full text-[21px] font-extrabold"
                style={{ background: STEP_STYLES[i].bg, color: STEP_STYLES[i].fg }}
              >
                {i + 1}
              </div>
              <h3 className="mb-[11px] text-[22px] font-bold tracking-[-0.02em] text-[#1A271F]">{s.title}</h3>
              <p className="text-[15.5px] leading-[1.6] text-[#56635A]">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Features ===== */}
      <section id="features" className="px-5 py-[90px] md:px-10 md:py-[118px]" style={{ background: "#F4ECDE", borderTop: "1px solid #ECE0CC", borderBottom: "1px solid #ECE0CC" }}>
        <div className="mx-auto max-w-[1180px]">
          <div className="mb-[60px] text-center">
            <div className="mb-[14px] text-[13px] font-bold uppercase tracking-[0.1em] text-eyebrow">{t.features.eyebrow}</div>
            <h2 className="font-display mx-auto max-w-[20ch] text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#1A271F]" style={{ textWrap: "balance" }}>
              {t.features.title}
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {t.features.items.map((f, i) => (
              <div key={i} className="rounded-[22px] px-[26px] pb-[34px] pt-8" style={{ background: "#FFFEFB", border: "1px solid #EBDFCB" }}>
                <div className="mb-6 flex h-[54px] w-[54px] items-center justify-center rounded-[16px]" style={{ background: FEATURE_STYLES[i].grad }}>
                  <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {FEATURE_STYLES[i].icon}
                  </svg>
                </div>
                <h3 className="mb-[10px] text-[19px] font-bold tracking-[-0.02em] text-[#1A271F]">{f.title}</h3>
                <p className="text-[15px] leading-[1.58] text-[#56635A]">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== Languages marquee ===== */}
      <section id="languages" className="overflow-hidden pt-[90px] md:pt-[110px]">
        <div className="mb-[54px] px-5 text-center md:px-10">
          <div className="mb-[14px] text-[13px] font-bold uppercase tracking-[0.1em] text-eyebrow">{t.languagesSection.eyebrow}</div>
          <h2 className="font-display mx-auto mb-4 max-w-[18ch] text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#1A271F]" style={{ textWrap: "balance" }}>
            {t.languagesSection.title}
          </h2>
          <p className="mx-auto max-w-[48ch] text-[17.5px] leading-[1.55] text-[#4A5750]">
            {t.languagesSection.body}
          </p>
        </div>
        <div className="flex w-max gap-[18px]" style={{ animation: "wf-marquee 38s linear infinite" }} dir="ltr">
          {[...MARQUEE_LANGS, ...MARQUEE_LANGS].map((m, i) => (
            <div key={i} className="flex items-baseline gap-[11px] whitespace-nowrap rounded-full px-[26px] py-[15px]" style={{ background: "#FFFEFB", border: "1px solid #EBDFCB" }}>
              <span className="text-2xl font-bold tracking-[-0.01em] text-[#2A3A30]">{m.nativeName}</span>
              <span className="text-sm text-[#A08A66]">{m.name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Trust ===== */}
      <section id="trust" className="mx-auto max-w-[1180px] px-5 pb-[100px] pt-5 md:px-10 md:pb-[118px]">
        <div className="relative overflow-hidden rounded-[30px] px-7 py-14 md:px-[60px] md:py-[72px]" style={{ background: "linear-gradient(135deg,#22332A,#1A271F)" }}>
          <svg viewBox="0 0 600 400" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 h-full w-full" style={{ opacity: 0.13 }}>
            {TRUST_RINGS.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="#E8A24A" strokeWidth="1.4" />
            ))}
          </svg>
          <div className="relative z-[2] max-w-[680px]">
            <div className="mb-[26px] inline-flex items-center gap-[9px] rounded-full px-[15px] py-2 text-[13px] font-bold text-[#F2C892]" style={{ background: "rgba(232,162,74,0.16)", border: "1px solid rgba(232,162,74,0.3)" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F2C892" strokeWidth="2.2">
                <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
              </svg>
              {t.trust.badge}
            </div>
            <h2 className="font-display mb-[22px] text-[clamp(28px,4vw,46px)] font-extrabold leading-[1.1] tracking-[-0.03em] text-[#FBF6EE]" style={{ textWrap: "balance" }}>
              {t.trust.title}
            </h2>
            <p className="mb-[34px] max-w-[56ch] text-[18px] leading-[1.6] text-[#C4D0C7]">
              {t.trust.body}
            </p>
            <div className="flex flex-wrap gap-[14px]">
              {t.trust.points.map((p) => (
                <div key={p} className="flex items-center gap-[9px] text-[15px] font-semibold text-[#DCE5DD]">
                  <span className="h-[7px] w-[7px] rounded-full" style={{ background: "#79B98C" }} />
                  {p}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===== Final CTA ===== */}
      <section id="start" className="relative overflow-hidden px-5 pb-[120px] pt-[100px] text-center md:px-10 md:pb-[130px] md:pt-[118px]" style={{ background: "linear-gradient(180deg,#FBEBCF 0%,#F3D8B9 45%,#E7DBE0 100%)" }}>
        <svg viewBox="0 0 1440 300" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[46%] w-full" style={{ opacity: 0.9 }}>
          {FOOT_RIDGES.map((r, i) => (
            <g key={i} style={{ animation: `wf-roll ${r.dur}s linear infinite`, willChange: "transform" }}>
              <path d={r.d} fill={r.fill} opacity={r.op} />
            </g>
          ))}
        </svg>
        <div className="relative z-[3] mx-auto max-w-[760px]">
          <h2 className="font-display text-[clamp(34px,5.2vw,62px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-[#1A271F]" style={{ textWrap: "balance" }}>
            {t.finalCta.title}
          </h2>
          <p className="mx-auto mt-[22px] max-w-[46ch] text-[19px] leading-[1.55] text-[#3C4A40]">
            {t.finalCta.body}
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-[14px]">
            <button
              onClick={start}
              className="inline-flex items-center gap-[9px] rounded-full px-[30px] py-4 text-[17px] font-bold text-[#241A0C] transition hover:brightness-[1.03] active:scale-[0.99] focus-visible:outline-none"
              style={{ background: accent, boxShadow: "0 14px 32px -10px rgba(224,147,74,.7)" }}
            >
              {t.finalCta.primary}
              {ARROW}
            </button>
            <a
              href="#how"
              className="inline-flex items-center gap-[9px] rounded-full px-7 py-4 text-[17px] font-semibold text-[#1A271F]"
              style={{ background: "rgba(255,255,255,0.7)", border: "1px solid rgba(255,255,255,0.9)" }}
            >
              {t.finalCta.secondary}
            </a>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="px-5 pb-11 pt-14 md:px-10" style={{ background: "#1A271F", color: "#9FB0A4" }}>
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-[11px]">
            <Logo size={26} />
            <span className="text-[18px] font-extrabold text-[#FBF6EE]">Wayfinder</span>
          </div>
          <div className="flex flex-wrap gap-7 text-[14.5px]">
            <a href="#how" className="text-[#9FB0A4] hover:text-[#FBF6EE]">{t.nav.howItWorks}</a>
            <a href="#features" className="text-[#9FB0A4] hover:text-[#FBF6EE]">{t.nav.features}</a>
            <a href="#languages" className="text-[#9FB0A4] hover:text-[#FBF6EE]">{t.nav.languages}</a>
            <a href="/auth/login" className="text-[#9FB0A4] hover:text-[#FBF6EE]">{t.nav.signIn}</a>
          </div>
          <span className="text-[13px] text-[#62736A]">{t.footer.tagline}</span>
        </div>
      </footer>
    </main>
  );
}
