import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  CardScreen,
  IdentityScreen,
  PinScreen,
  SettingsScreen,
  SignScreen,
  VerifyScreen,
} from "./components/screens";
import { locale, setLocale, text } from "./lib/i18n";
import { banner, screen, signBusy, signProgress, type Screen } from "./lib/state";

type ScreenMeta = {
  id: Screen;
  ja: string;
  en: string;
  descriptionJa: string;
  descriptionEn: string;
};

const TABS: ScreenMeta[] = [
  {
    id: "card",
    ja: "カード",
    en: "Card",
    descriptionJa: "リーダー、証明書、PIN 状態を安全に確認",
    descriptionEn: "Inspect readers, certificates and PIN status safely",
  },
  {
    id: "identity",
    ja: "券面",
    en: "Card face",
    descriptionJa: "基本4情報、券面画像、顔写真をカードから確認",
    descriptionEn: "Read attributes, rendered fields and the card photograph",
  },
  {
    id: "sign",
    ja: "署名",
    en: "Sign",
    descriptionJa: "PDF とファイルに JPKI 電子署名を追加",
    descriptionEn: "Add JPKI signatures to PDFs and files",
  },
  {
    id: "verify",
    ja: "検証",
    en: "Verify",
    descriptionJa: "署名、文書の同一性、証明書チェーンを確認",
    descriptionEn: "Check signatures, document integrity and certificate chains",
  },
  {
    id: "pin",
    ja: "PIN",
    en: "PIN",
    descriptionJa: "残り回数を確認し、3 種類の暗証番号を変更",
    descriptionEn: "Check retries and change the three supported credentials",
  },
  {
    id: "settings",
    ja: "設定",
    en: "Settings",
    descriptionJa: "タイムスタンプと検証ポリシーを管理",
    descriptionEn: "Manage timestamp and verification policies",
  },
];

const STAGES: Record<string, string> = {
  signing: "署名中",
  timestamping: "タイムスタンプ取得中",
  writing: "書き出し中",
};

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

function NavIcon({ id }: { id: Screen }): ComponentChild {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (id) {
    case "card":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M7 10h5M7 14h3M16 10h1M16 14h1" />
        </svg>
      );
    case "identity":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <circle cx="8" cy="10" r="2" />
          <path d="M5.5 16c.8-2 4.2-2 5 0M13 9h5M13 13h5M13 17h3" />
        </svg>
      );
    case "sign":
      return (
        <svg {...common}>
          <path d="M5 19h14M7 16l1.2-4.2L16 4l4 4-7.8 7.8L8 17z" />
          <path d="m14.5 5.5 4 4" />
        </svg>
      );
    case "verify":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4.5 2.7 8 7 10 4.3-2 7-5.5 7-10V6z" />
          <path d="m8.5 12 2.2 2.2 4.8-5" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <circle cx="8" cy="12" r="4" />
          <path d="M12 12h9M17 12v3M20 12v2" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />
        </svg>
      );
  }
}

function screenFor(id: Screen) {
  switch (id) {
    case "card":
      return <CardScreen />;
    case "identity":
      return <IdentityScreen />;
    case "sign":
      return <SignScreen />;
    case "verify":
      return <VerifyScreen />;
    case "pin":
      return <PinScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}

export function App() {
  const current = screen.value;
  const message = banner.value;
  const progress = signProgress.value;
  const language = locale.value;
  const meta = TABS.find((item) => item.id === current) ?? TABS[0];

  const selected = TABS.findIndex(({ id }) => id === current);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState(selected);

  useEffect(() => {
    setFocused(selected);
  }, [selected]);

  useEffect(() => {
    document.title = `Myna GUI — ${language === "ja" ? meta.ja : meta.en}`;
  }, [language, meta]);

  /** Keep a message scoped to the screen that raised it. */
  const showing = useRef<number | null>(null);
  useEffect(() => {
    const shown = banner.peek();
    if (shown && shown.seq === showing.current) banner.value = null;
  }, [current]);
  useEffect(() => {
    showing.current = message?.seq ?? null;
  }, [message?.seq]);

  function move(event: KeyboardEvent, index: number) {
    const last = TABS.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocused(next);
    tabs.current[next]?.focus();
  }

  function select(id: Screen) {
    screen.value = id;
  }

  const dismiss = (
    <button class="ghost small banner-dismiss" aria-label="この通知を閉じる" onClick={() => (banner.value = null)}>
      閉じる
    </button>
  );

  const shown = message && (
    <div key={message.seq} class={`banner banner-${message.tone}`}>
      <span>{message.text}</span>
      {dismiss}
    </div>
  );

  return (
    <div class="app-shell">
      <aside class="app-rail">
        <div class="brand-lockup">
          <div class="brand-mark" aria-hidden="true">
            <span>M</span>
          </div>
          <div>
            <strong>Myna</strong>
            <span>GUI</span>
          </div>
        </div>

        <div class="rail-kicker">JPKI UTILITY</div>
        <nav class="tabs" role="tablist" aria-label="画面" aria-orientation="vertical">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              class="tab"
              role="tab"
              type="button"
              aria-selected={current === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={focused === index ? 0 : -1}
              onClick={() => select(item.id)}
              onKeyDown={(event) => move(event, index)}
            >
              <span class="tab-icon"><NavIcon id={item.id} /></span>
              <span class="tab-copy">
                <span>{language === "ja" ? item.ja : item.en}</span>
                {item.id === "sign" && signBusy.value && <small class="tab-busy">実行中</small>}
              </span>
            </button>
          ))}
        </nav>

        <div class="rail-security">
          <span class="security-dot" aria-hidden="true" />
          <div>
            <strong>{text("ローカル処理", "Local processing")}</strong>
            <span>{text("PIN と文書は端末内で処理", "PIN and documents stay on device")}</span>
          </div>
        </div>
      </aside>

      <div class="workspace">
        <header class="topbar">
          <div class="page-identity">
            <span class="page-eyebrow">JPKI DESKTOP</span>
            <strong class="page-title">{language === "ja" ? meta.ja : meta.en}</strong>
            <span class="page-description">
              {language === "ja" ? meta.descriptionJa : meta.descriptionEn}
            </span>
          </div>

          <div
            class="locale-switch"
            data-locale={language}
            role="group"
            aria-label={text("表示言語", "Display language")}
          >
            <button
              type="button"
              class={language === "ja" ? "active" : ""}
              aria-pressed={language === "ja"}
              onClick={() => setLocale("ja")}
            >
              JP
            </button>
            <button
              type="button"
              class={language === "en" ? "active" : ""}
              aria-pressed={language === "en"}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
          </div>

          <div class="announcements">
            <div role="status" aria-live="polite">
              {message && message.tone !== "error" && shown}
            </div>
            <div role="alert" aria-live="assertive">
              {message && message.tone === "error" && shown}
            </div>
          </div>

          <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
            {progress && progress.stage !== "done" && (
              <span key={`${progress.index}-${progress.stage}`}>
                {STAGES[progress.stage] ?? "処理中"} {progress.index + 1}/{progress.total}
                {progress.path && ` ${basename(progress.path)}`}
              </span>
            )}
          </div>
        </header>

        <main class="workspace-content">
          {TABS.map(({ id }) => (
            <div
              key={id}
              id={`panel-${id}`}
              role="tabpanel"
              aria-labelledby={`tab-${id}`}
              hidden={current !== id}
            >
              {current === id && screenFor(id)}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
