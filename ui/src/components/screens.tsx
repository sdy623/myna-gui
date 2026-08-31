/**
 * The four screens.
 *
 * # What lives where
 *
 * A signing run outlives the screen that started it. The card is working, a timestamp authority is
 * being waited on, and the signatures already made are held in Rust — so a tab change must not
 * re-enable the button, lose the results, or forget that something is still unwritten. Everything
 * about a run therefore lives in `state.ts` as signals, and this file keeps only what is allowed to
 * die with the screen: which confirmation is showing, which file is in a slot.
 *
 * The pending queue drawn here is a copy for display. The signatures themselves are Rust's, and
 * every action that touches them asks Rust again for what is left rather than deducing it from what
 * was on screen.
 *
 * # One vocabulary for one fact
 *
 * The card screen and the sign screen both say whether this card can sign and how many attempts are
 * left. They say it in the same words, from the helpers below, because two wordings for one fact
 * read as two different problems.
 */
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";

import {
  api,
  asAppError,
  describe,
  describeSex,
  describeSubstitutes,
  formatJst,
  LABELS,
  PIN_BLOCKED,
  type AppError,
  type CertificateInfo,
  type CardImage,
  type ChangePinKind,
  type PdfSignatureVerification,
  type PendingAction,
  type PendingInfo,
  type PgpVerification,
  type PlannedOutput,
  type Progress,
  type SideOutput,
  type SignOutcome,
  type TimestampVerification,
  type TsaConfig,
} from "../lib/api";
import {
  pdfClaims,
  pgpClaims,
  reportLines,
  type ReportSigner,
  type Tone,
} from "../lib/claims";
import {
  acceptTestHierarchy,
  authCaCertificate,
  authCertificate,
  cardIdentity,
  cardStatus,
  clearCard,
  cleartext,
  customTsaUrl,
  embedCertificate,
  exportPublicKey,
  invisibleSignature,
  notify,
  pdfOptions,
  pending,
  pinStatuses,
  resetPdfPlacement,
  screen,
  setSignPinRetries,
  signBusy,
  signCertificate,
  signCaCertificate,
  signPendingBlocked,
  signProgress,
  signResults,
  signSideOutputs,
  signingFailure,
  tsa,
  writeTsr,
} from "../lib/state";
import { locale, text, translateReportLine } from "../lib/i18n";
import { PasswordDialog, type Disclosure, type SigningSubject } from "./PasswordDialog";
import { PdfPlacement } from "./PdfPlacement";
import { Claim, Signer, TimestampClaim, VerdictGroups } from "./Verdict";

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The folder a file is in, or nothing when the path names no folder.
 *
 * Shown beside the name wherever a choice is being confirmed: two files called `契約書.pdf` from
 * two folders are the same line otherwise, and the difference between them is the whole question.
 */
function dirname(path: string): string | null {
  const cut = path.search(/[\\/][^\\/]*$/);
  if (cut < 0) return null;
  return path.slice(0, cut) || "/";
}

// --- What the card can and cannot do, said once -------------------------------------------------

/**
 * A card operation is in flight.
 *
 * Module scope rather than component state: 接続 and 切断 are offered on two screens, and a button
 * that still looks ready while the other screen is talking to the card invites a second session.
 */
const cardBusy = signal(false);

/** How many files the last run was asked to sign, so the result heading can add up to something. */
const signRequested = signal(0);

/**
 * How many of them were thrown away on purpose.
 *
 * Counted, because otherwise a discarded signature leaves the heading short by one and the missing
 * file turns into "結果が分かりません" — which is not what happened, and not what was chosen.
 */
const signDiscarded = signal(0);

const NO_SIGN_CERTIFICATE =
  "このカードには署名用電子証明書がありません（15 歳未満などでは発行されません）。このカードでは署名できません。";

/**
 * How to read the remaining attempts.
 *
 * `null` is not "fine": the card did not answer, so the count could be anything, including one. It
 * used to fall through to the green tick at the end of a ternary, which is the one reading that is
 * certainly wrong.
 */
function retriesTone(retries: number | null): Tone {
  if (retries === null) return "unknown";
  if (retries === 0) return "bad";
  return retries <= 2 ? "warn" : "ok";
}

function retriesSummary(retries: number | null): string {
  if (retries === null) return "残り回数を確認できませんでした";
  if (retries === 0) return PIN_BLOCKED.claim;
  return `残り ${retries} 回`;
}

/**
 * What the number means for the holder.
 *
 * The count on its own is a number; what makes it worth reading is that the card is one office
 * visit away from being unusable. The maximum is never named — the card reports what is left and
 * nothing else, so a hardcoded five would be this program's invention rather than the card's word.
 */
function retriesConsequence(retries: number | null): string {
  if (retries === null) {
    return "すでに何回間違えているか分かりません。続けて間違えるとロックされます。";
  }
  if (retries === 0) return PIN_BLOCKED.sentence;
  return `あと ${retries} 回続けて間違えるとロックされ、市区町村の窓口でしか解除できません。`;
}

/**
 * Open a session and read what can be read without a password.
 *
 * Shared by both screens that offer it. A second copy that forgot `authCertificate()` or the banner
 * would leave the two screens disagreeing about the same card.
 */
async function connectCard(reader: string | null) {
  cardBusy.value = true;
  try {
    const status = await api.connect(reader);
    // A new session means every process-local value from the old card is stale, even when the
    // reader name is the same.
    clearCard();
    cardStatus.value = status;
    if (status.hasAuthCertificate) {
      authCertificate.value = await api.authCertificate();
      authCaCertificate.value = await api.authCaCertificate();
    }
    notify("info", "カードを読み取りました。");
  } catch (e) {
    notify("error", describe(asAppError(e)));
  } finally {
    cardBusy.value = false;
  }
}

/**
 * Reset the JPKI security status and drop the session.
 *
 * A successful MF selection is the card's acknowledgement that JPKI was left. Per JICSAP 5.1.3,
 * selecting another application clears the security status of the application left, so the next
 * signature must present the password again even though card power was not interrupted. "ロック"
 * is kept for one meaning only: five wrong attempts and a trip to the town hall.
 */
async function disconnectCard() {
  cardBusy.value = true;
  try {
    await api.disconnect();
    clearCard();
    notify(
      "info",
      "カードを切断し、セキュリティ状態をリセットしました。パスワードは本アプリに残っておらず、次に署名するときはもう一度入力が必要です。",
    );
  } catch (e) {
    notify("error", describe(asAppError(e)));
  } finally {
    cardBusy.value = false;
  }
}

function signingPasswordError(value: string): string | null {
  if (/[a-z]/.test(value)) {
    return text(
      "英字は大文字で入力してください。",
      "Use uppercase letters; the signing password is registered in uppercase.",
    );
  }
  if (!/^[A-Z0-9]*$/.test(value)) {
    return text("使えるのは英大文字と数字だけです。", "Only uppercase letters and digits are allowed.");
  }
  if (value.length < 6 || value.length > 16) {
    return text("署名用パスワードは 6〜16 文字です。", "The signing password must be 6–16 characters.");
  }
  return null;
}

function describeCredentialError(error: AppError, label: string): string {
  if (error.kind === "pinIncorrect") {
    return error.retries === null
      ? text(`${label}が違います。残り回数は不明です。`, `${label} is incorrect. Remaining attempts are unknown.`)
      : text(
          `${label}が違います。残り ${error.retries} 回です。`,
          `${label} is incorrect. ${error.retries} attempt(s) remain.`,
        );
  }
  if (error.kind === "pinBlocked") {
    return text(
      `${label}はロックされています。市区町村の窓口でのみ解除できます。`,
      `${label} is locked and can only be reset at a municipal service counter.`,
    );
  }
  return describe(error);
}

// --- Card ---------------------------------------------------------------------------------------

export function CardScreen() {
  // `null` until asked, so "not searched yet" and "searched and found none" do not look alike.
  const [readers, setReaders] = useState<string[] | null>(null);
  const [showSignRead, setShowSignRead] = useState(false);
  const [signPassword, setSignPassword] = useState("");
  const [showSignPassword, setShowSignPassword] = useState(false);
  const [signReadBusy, setSignReadBusy] = useState(false);
  const [signReadError, setSignReadError] = useState<string | null>(null);
  const [lastAttemptConfirmed, setLastAttemptConfirmed] = useState(false);
  const busy = cardBusy.value;

  async function readSigningCertificates(event: Event) {
    event.preventDefault();
    const invalid = signingPasswordError(signPassword);
    if (invalid) {
      setSignReadError(invalid);
      return;
    }
    const remaining = cardStatus.value?.signPinRetries ?? null;
    if ((remaining === null || remaining === 1) && !lastAttemptConfirmed) {
      setLastAttemptConfirmed(true);
      setSignReadError(
        remaining === 1
          ? text(
              "次に間違えるとロックされます。内容を確認し、もう一度押してください。",
              "One more incorrect entry will lock this password. Check it, then press again.",
            )
          : text(
              "残り回数が不明です。次でロックされる可能性があります。確認してもう一度押してください。",
              "The remaining count is unknown and the next entry may lock it. Check it, then press again.",
            ),
      );
      return;
    }

    setSignReadBusy(true);
    setSignReadError(null);
    setShowSignPassword(false);
    try {
      const certificates = await api.readSignCertificates(signPassword);
      signCertificate.value = certificates.certificate;
      signCaCertificate.value = certificates.caCertificate;
      setSignPassword("");
      setShowSignRead(false);
      setLastAttemptConfirmed(false);
      try {
        setSignPinRetries(await api.signPinRetries());
      } catch {
        // The certificate read succeeded; a counter that cannot be re-read does not undo it.
      }
      notify(
        "info",
        text(
          "署名用証明書を読み取り、カード上の署名権限は直ちにリセットしました。",
          "Read the signing certificate and immediately reset signing authorization on the card.",
        ),
      );
    } catch (thrown) {
      const failure = asAppError(thrown);
      if (failure.kind === "pinIncorrect" && failure.retries !== null) {
        setSignPinRetries(failure.retries);
      } else if (failure.kind === "pinBlocked") {
        setSignPinRetries(0);
      }
      setSignReadError(describeCredentialError(failure, text("署名用パスワード", "Signing password")));
      setSignPassword("");
      setLastAttemptConfirmed(false);
    } finally {
      setSignReadBusy(false);
    }
  }

  async function refresh() {
    cardBusy.value = true;
    try {
      setReaders(await api.listReaders());
    } catch (e) {
      setReaders(null);
      notify("error", describe(asAppError(e)));
    } finally {
      cardBusy.value = false;
    }
  }

  const status = cardStatus.value;
  const retries = status?.signPinRetries ?? null;
  return (
    <section class="screen">
      <h1>カード</h1>

      <div class="row">
        <button onClick={refresh} disabled={busy}>
          リーダーを探す
        </button>
        <button onClick={() => connectCard(null)} disabled={busy}>
          接続
        </button>
        <button class="ghost" onClick={disconnectCard} disabled={busy || !status}>
          切断
        </button>
      </div>

      <p class="note">
        {text(
          "接続時に読み出すのは利用者証明用電子証明書だけです。署名用電子証明書（氏名・住所・生年月日・性別）は、署名時または下の「署名用証明書を読む」でパスワードを入力したときだけ読み出します。",
          "Only the authentication certificate is read when connecting. The signing certificate (name, address, date of birth, and sex) is read only after you enter its password for signing or choose Read signing certificate below.",
        )}
      </p>
      <p class="note">
        接続している間、本アプリはカードを占有します。切断するまで、e-Tax や JPKI
        利用者ソフトなどからはこのカードを使えません。ほかのアプリが先に使っているときは接続できません。
      </p>

      {readers !== null && readers.length === 0 && (
        <div class="empty">
          <p>カードリーダーが 1 台も見つかりませんでした。</p>
          <p class="note">
            リーダーが接続されているか、PC/SC のサービス（Windows は「スマートカード」、Linux は
            <code>pcscd</code>）が動いているかを確認してから、もう一度「リーダーを探す」を押してください。
          </p>
        </div>
      )}

      {readers !== null && readers.length > 0 && (
        <ul class="readers">
          {readers.map((reader) => (
            <li key={reader}>
              <code>{reader}</code>
              <button class="ghost small" onClick={() => connectCard(reader)} disabled={busy}>
                これに接続
              </button>
            </li>
          ))}
        </ul>
      )}

      {status && (
        <div class="panel">
          <Claim label="リーダー" tone="ok" state={null}>
            {status.reader}
          </Claim>
          {/* The state word is left to `Claim`, which takes it from the same table the exported
              text file labels its lines with. A second copy here is a second thing to keep true. */}
          <Claim label={LABELS.token} tone={status.physicalCard ? "ok" : "warn"}>
            {status.tokenType}
            {status.physicalCard ? "（マイナンバーカード）" : "（スマホ用電子証明書）"}
          </Claim>
          <Claim label="署名用電子証明書" tone={status.hasSignCertificate ? "ok" : "bad"}>
            {status.hasSignCertificate ? "あり" : NO_SIGN_CERTIFICATE}
          </Claim>
          <Claim label="署名用パスワード" tone={retriesTone(retries)}>
            {retriesSummary(retries)}
            <small class="chain">{retriesConsequence(retries)}</small>
          </Claim>
        </div>
      )}

      {authCertificate.value && (
        <details class="panel">
          <summary>
            {text(
              "利用者証明用電子証明書 — auth（パスワード不要）",
              "User-authentication certificate — auth (no PIN required)",
            )}
          </summary>
          <CertificateTable certificate={authCertificate.value} />
        </details>
      )}

      {authCaCertificate.value && (
        <details class="panel">
          <summary>
            {text("利用者証明用 CA 証明書 — auth_ca", "User-authentication CA certificate — auth_ca")}
          </summary>
          <CertificateTable certificate={authCaCertificate.value} />
        </details>
      )}

      {status?.hasSignCertificate && !showSignRead && (
        <div class="panel certificate-action">
          <h2>{text("署名用証明書を読む", "Read the signing certificate")}</h2>
          <p class="note">
            {text(
              "myna jpki cert -t sign（別名 signature / digital_signature）と sign_ca に相当します。6〜16 文字の署名用パスワードが必要です。読み取り後は署名権限を残しません。",
              "Equivalent to myna jpki cert -t sign (aliases: signature / digital_signature) and sign_ca. It requires the 6–16 character signing password and does not leave the key authorized afterward.",
            )}
          </p>
          <button onClick={() => setShowSignRead(true)} disabled={busy || retries === 0}>
            {text("署名用証明書を読み取る", "Read signing certificate")}
          </button>
        </div>
      )}

      {showSignRead && (
        <form class="panel credential-panel" onSubmit={readSigningCertificates}>
          <h2>{text("署名用パスワード", "Signing password")}</h2>
          <p class="warn-box">
            {text(
              `${retriesSummary(retries)}。誤入力はカードの残り回数を 1 回消費します。`,
              `${retries === null ? "Remaining attempts unknown" : `${retries} attempt(s) remaining`}. An incorrect entry consumes one attempt.`,
            )}
          </p>
          <label class="field">
            <span>{text("6〜16 文字（英大文字・数字）", "6–16 uppercase letters or digits")}</span>
            <input
              type={showSignPassword ? "text" : "password"}
              value={signPassword}
              maxLength={16}
              autoComplete="off"
              spellcheck={false}
              onInput={(event) => {
                setSignPassword((event.currentTarget as HTMLInputElement).value);
                setSignReadError(null);
                setLastAttemptConfirmed(false);
              }}
            />
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={showSignPassword}
              onChange={(event) => setShowSignPassword(event.currentTarget.checked)}
            />
            <span>{text("入力を表示", "Show password")}</span>
          </label>
          {signReadError && <p class="form-error" role="alert">{signReadError}</p>}
          <div class="row">
            <button type="submit" disabled={signReadBusy || retries === 0}>
              {signReadBusy ? text("読み取り中…", "Reading…") : text("読み取る", "Read")}
            </button>
            <button
              type="button"
              class="ghost"
              disabled={signReadBusy}
              onClick={() => {
                setShowSignRead(false);
                setSignPassword("");
                setSignReadError(null);
                setLastAttemptConfirmed(false);
              }}
            >
              {text("キャンセル", "Cancel")}
            </button>
          </div>
        </form>
      )}

      {signCertificate.value && (
        <details class="panel" open>
          <summary>{text("署名用電子証明書 — sign", "Signing certificate — sign")}</summary>
          <p class="warn-box">
            この証明書には基本4情報が含まれます。.asc では埋め込むかどうかを選べます。PDF
            では必ず埋め込まれます。埋め込んだファイルを渡すことは、これらの情報を渡すことです。
          </p>
          <CertificateTable certificate={signCertificate.value} />
        </details>
      )}

      {signCaCertificate.value && (
        <details class="panel">
          <summary>{text("署名用 CA 証明書 — sign_ca", "Signing CA certificate — sign_ca")}</summary>
          <CertificateTable certificate={signCaCertificate.value} />
        </details>
      )}

      {status && (
        <div class="status-block">
          <strong>{text("失効状態：未照会", "Revocation status: not queried")}</strong>
          <p class="note">
            {text(
              "証明書の有効期間・用途・署名・J-LIS ルートへのチェーンは検証できますが、現在の myna と本アプリは CRL/OCSP を問い合わせません。「失効していない」とは表示しません。",
              "Validity, key usage, signatures and the chain to a J-LIS root can be checked, but current myna and this app do not query CRL or OCSP. The app never labels a certificate as not revoked.",
            )}
          </p>
        </div>
      )}
    </section>
  );
}

function cardImageUrl(image: CardImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function decodeBase64(value: string): number[] {
  const decoded = atob(value);
  return Array.from(decoded, (character) => character.charCodeAt(0));
}

async function exportCardImage(image: CardImage, basename: string) {
  const path = await save({
    title: text("カード画像を保存", "Save card image"),
    defaultPath: `${basename}.${image.extension}`,
    filters: [
      {
        name: image.extension.toUpperCase(),
        extensions: [image.extension],
      },
    ],
  });
  if (!path) return;
  await api.saveCardImage(path, decodeBase64(image.base64));
  notify("info", text("画像を保存しました。", "Image saved."));
}

function applyPinStatuses(values: Awaited<ReturnType<typeof api.pinStatuses>>) {
  pinStatuses.value = values;
  const status = cardStatus.value;
  if (status) {
    cardStatus.value = {
      ...status,
      authPinRetries: values.authPin,
      signPinRetries: values.signPin,
    };
  }
  // The backend selected the text and surface APs to read these counters. That clears JPKI VERIFY.
  signCertificate.value = null;
  signCaCertificate.value = null;
}

// --- Card face ----------------------------------------------------------------------------------

export function IdentityScreen() {
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const status = cardStatus.value;
  const identity = cardIdentity.value;
  const attempts = pinStatuses.value?.cardPin ?? null;

  async function readIdentity(event: Event) {
    event.preventDefault();
    if (!/^\d{4}$/.test(password)) {
      setError(text("暗証番号は 4 桁の数字です。", "The card PIN must be exactly four digits."));
      return;
    }
    if ((attempts === null || attempts === 1) && !dangerConfirmed) {
      setDangerConfirmed(true);
      setError(
        attempts === 1
          ? text(
              "次に間違えるとロックされます。暗証番号を確認して、もう一度押してください。",
              "One more incorrect entry will lock this PIN. Check it, then press again.",
            )
          : text(
              "残り回数が不明です。次でロックされる可能性があります。確認してもう一度押してください。",
              "The remaining count is unknown and the next entry may lock it. Check it, then press again.",
            ),
      );
      return;
    }

    setBusy(true);
    setError(null);
    setReveal(false);
    // Selecting 券面AP clears any JPKI VERIFY, and the Rust side mirrors that state.
    signCertificate.value = null;
    signCaCertificate.value = null;
    try {
      cardIdentity.value = await api.readCardIdentity(password);
      setPassword("");
      setDangerConfirmed(false);
      try {
        applyPinStatuses(await api.pinStatuses());
      } catch {
        // Personal data was read and verified; an optional counter refresh does not undo it.
      }
      notify(
        "info",
        text(
          "券面情報と写真を読み取り、署名とカード存在証明を検証しました。",
          "Read the card face and photograph, then verified the records and live-card proof.",
        ),
      );
    } catch (thrown) {
      const failure = asAppError(thrown);
      if (failure.kind === "pinIncorrect" && failure.retries !== null && pinStatuses.value) {
        pinStatuses.value = { ...pinStatuses.value, cardPin: failure.retries };
      }
      setError(describeCredentialError(failure, text("券面入力補助用暗証番号", "Card input-helper PIN")));
      setPassword("");
      setDangerConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="screen identity-screen">
      <h1>{text("券面・基本4情報", "Card face & identity")}</h1>

      {!status && (
        <div class="empty">
          <p>{text("先にカードへ接続してください。", "Connect to a card first.")}</p>
          <button class="ghost" onClick={() => (screen.value = "card")}>
            {text("カード画面を開く", "Open Card screen")}
          </button>
        </div>
      )}

      {status && !status.physicalCard && (
        <div class="warn-box">
          {text(
            "券面情報は物理マイナンバーカードにだけあります。スマホ用電子証明書では読み取れません。",
            "Card-face data exists only on a physical Individual Number Card, not a mobile certificate.",
          )}
        </div>
      )}

      {status?.physicalCard && (
        <form class="panel credential-panel" onSubmit={readIdentity}>
          <h2>{text("カードから読み取る", "Read from card")}</h2>
          <p class="note">
            {text(
              "4 桁の券面入力補助用暗証番号で基本4情報を読み、内部でのみ個人番号を照合番号Aとして使って券面画像と写真を取得します。個人番号は画面にもログにも返しません。",
              "The four-digit input-helper PIN reads the basic attributes. The Individual Number is used only internally as verification code A to read the rendered fields and photograph; it is never returned to the UI or logs.",
            )}
          </p>
          <label class="field compact-field">
            <span>{text("券面入力補助用暗証番号（4 桁）", "Card input-helper PIN (4 digits)")}</span>
            <input
              type={reveal ? "text" : "password"}
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              value={password}
              autoComplete="off"
              onInput={(event) => {
                setPassword((event.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 4));
                setError(null);
                setDangerConfirmed(false);
              }}
            />
          </label>
          <label class="check">
            <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.currentTarget.checked)} />
            <span>{text("入力を表示", "Show PIN")}</span>
          </label>
          {pinStatuses.value && (
            <p class={attempts !== null && attempts <= 2 ? "warn-box" : "status-block"}>
              {text("残り回数", "Attempts remaining")}: {attempts === null ? text("不明", "unknown") : attempts}
            </p>
          )}
          {error && <p class="form-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || attempts === 0}>
            {busy ? text("読み取り・検証中…", "Reading & verifying…") : text("券面と写真を読む", "Read card face & photo")}
          </button>
        </form>
      )}

      {identity && (
        <>
          <div class="identity-card panel">
            <div class="identity-photo-wrap">
              <img
                class="identity-photo"
                src={cardImageUrl(identity.photoPreview)}
                alt={text("カードから読み取った顔写真", "Portrait read from the card")}
              />
              <button class="ghost small" onClick={() => exportCardImage(identity.photoOriginal, "myna-card-photo")}>
                {text("原本 JP2 を保存", "Save original JP2")}
              </button>
            </div>
            <div class="identity-fields">
              <div>
                <span>{text("氏名（券面画像）", "Name (rendered)")}</span>
                <img src={cardImageUrl(identity.nameImage)} alt={text("券面の氏名画像", "Rendered name")} />
              </div>
              <div>
                <span>{text("住所（券面画像）", "Address (rendered)")}</span>
                <img src={cardImageUrl(identity.addressImage)} alt={text("券面の住所画像", "Rendered address")} />
              </div>
            </div>
          </div>

          <div class="panel identity-details">
            <h2>{text("基本4情報", "Basic identity attributes")}</h2>
            <dl class="holder">
              <dt>{text("氏名", "Name")}</dt><dd>{identity.name}</dd>
              <dt>{text("住所", "Address")}</dt><dd>{identity.address}</dd>
              <dt>{text("生年月日", "Date of birth")}</dt><dd>{identity.birthDate}</dd>
              <dt>{text("性別", "Sex")}</dt><dd>{describeSex(identity.sex)}</dd>
              <dt>{text("券面有効期限", "Card-face expiry")}</dt><dd>{identity.expiry}</dd>
            </dl>
          </div>

          <div class="panel">
            <h2>{text("読み取り検証", "Read verification")}</h2>
            <Claim label={text("券面データの署名", "Card-face record signature")} tone={identity.dataVerified ? "ok" : "bad"}>
              {identity.dataVerified ? text("検証済み", "Verified") : text("検証失敗", "Failed")}
            </Claim>
            <Claim label={text("実カード存在証明", "Live-card proof")} tone={identity.cardPresentVerified ? "ok" : "bad"}>
              {identity.cardPresentVerified ? text("チャレンジ署名を検証済み", "Fresh challenge signature verified") : text("未検証", "Not verified")}
            </Claim>
            <Claim label={text("券面有効期限", "Card-face expiry")} tone="unknown">
              {text(
                "値は読み取り済みですが、この券面レコードの署名対象外です。",
                "Read successfully, but this field is outside the signed part of the card-face record.",
              )}
            </Claim>
          </div>

          <div class="row">
            <button class="ghost" onClick={() => exportCardImage(identity.nameImage, "myna-card-name")}>
              {text("氏名 PNG を保存", "Save name PNG")}
            </button>
            <button class="ghost" onClick={() => exportCardImage(identity.addressImage, "myna-card-address")}>
              {text("住所 PNG を保存", "Save address PNG")}
            </button>
            <button
              class="ghost destructive"
              onClick={() => {
                cardIdentity.value = null;
                notify("info", text("画面上の券面情報を消去しました。", "Cleared card-face data from the UI."));
              }}
            >
              {text("画面から消去", "Clear from UI")}
            </button>
          </div>
          <p class="note">
            {text(
              "情報と画像はこのアプリのメモリ内だけにあり、切断・消去・終了で破棄されます。保存ボタンを押した画像だけがディスクへ書き出されます。",
              "Data and images remain only in this app's memory and are discarded on disconnect, clear, or exit. Only images you explicitly save are written to disk.",
            )}
          </p>
        </>
      )}
    </section>
  );
}

// --- PIN management ----------------------------------------------------------------------------

function counterTone(value: number | null): Tone {
  if (value === null) return "unknown";
  if (value === 0) return "bad";
  return value <= 2 ? "warn" : "ok";
}

function counterText(value: number | null): string {
  if (value === null) return text("カードが回数を報告しませんでした", "The card did not report a finite count");
  if (value === 0) return text("ロック済み", "Locked");
  return text(`残り ${value} 回`, `${value} attempt(s) remaining`);
}

function updateChangedPinRetry(kind: ChangePinKind, retries: number | null) {
  if (retries === null || !pinStatuses.value) return;
  const current = pinStatuses.value;
  pinStatuses.value =
    kind === "card"
      ? { ...current, cardPin: retries }
      : kind === "auth"
        ? { ...current, authPin: retries }
        : { ...current, signPin: retries };
  if (kind === "sign") setSignPinRetries(retries);
  if (kind === "auth" && cardStatus.value) {
    cardStatus.value = { ...cardStatus.value, authPinRetries: retries };
  }
}

interface PinChangePanelProps {
  kind: ChangePinKind;
  labelJa: string;
  labelEn: string;
  retries: number | null;
  statusesLoaded: boolean;
  onChanged: () => Promise<void>;
}

function PinChangePanel({ kind, labelJa, labelEn, retries, statusesLoaded, onChanged }: PinChangePanelProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dangerConfirmed, setDangerConfirmed] = useState(false);
  const label = text(labelJa, labelEn);
  const signing = kind === "sign";

  function normalize(value: string): string {
    const normalized = signing ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : value.replace(/\D/g, "");
    return normalized.slice(0, signing ? 16 : 4);
  }

  function clearSecrets() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setReveal(false);
  }

  async function submit(event: Event) {
    event.preventDefault();
    const currentError = signing
      ? signingPasswordError(current)
      : /^\d{4}$/.test(current)
        ? null
        : text("現在の暗証番号は 4 桁の数字です。", "The current PIN must be exactly four digits.");
    const nextError = signing
      ? signingPasswordError(next)
      : /^\d{4}$/.test(next)
        ? null
        : text("新しい暗証番号は 4 桁の数字です。", "The new PIN must be exactly four digits.");
    if (currentError || nextError) {
      setError(currentError ?? nextError);
      return;
    }
    if (next !== confirm) {
      setError(text("新しい値と確認入力が一致しません。", "The new value and confirmation do not match."));
      return;
    }
    if (current === next) {
      setError(text("新しい値は現在の値と異なるものにしてください。", "Choose a new value different from the current one."));
      return;
    }
    if ((retries === null || retries === 1) && !dangerConfirmed) {
      setDangerConfirmed(true);
      setError(
        retries === 1
          ? text("次に間違えるとロックされます。確認してもう一度押してください。", "One more error will lock it. Check the current value and press again.")
          : text("残り回数が不明です。確認してもう一度押してください。", "Remaining attempts are unknown. Check the current value and press again."),
      );
      return;
    }

    setBusy(true);
    setError(null);
    signCertificate.value = null;
    signCaCertificate.value = null;
    try {
      await api.changePin(kind, current, next);
      clearSecrets();
      setDangerConfirmed(false);
      await onChanged();
      notify("info", text(`${label}を変更しました。`, `${label} changed.`));
    } catch (thrown) {
      const failure = asAppError(thrown);
      if (failure.kind === "pinIncorrect") updateChangedPinRetry(kind, failure.retries);
      if (failure.kind === "pinBlocked") updateChangedPinRetry(kind, 0);
      setError(describeCredentialError(failure, label));
      clearSecrets();
      setDangerConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="panel pin-change" onSubmit={submit}>
      <input
        type="text"
        name="username"
        value={`jpki-${kind}`}
        autoComplete="username"
        readOnly
        hidden
        aria-hidden="true"
      />
      <div class="panel-heading-row">
        <div>
          <h2>{label}</h2>
          <span class={`retry-chip retry-${counterTone(retries)}`}>{counterText(retries)}</span>
        </div>
        <code>{kind === "card" ? "pin change card" : kind === "auth" ? "pin change auth" : "pin change sign"}</code>
      </div>
      <p class="note">
        {signing
          ? text("6〜16 文字の英大文字・数字。", "6–16 uppercase ASCII letters or digits.")
          : text("4 桁の数字。", "Exactly four digits.")}
        {text(" 現在の値が違うと残り回数を 1 回消費します。", " An incorrect current value consumes one attempt.")}
      </p>
      <div class="pin-fields">
        {[
          [text("現在の値", "Current value"), current, setCurrent, "current-password"],
          [text("新しい値", "New value"), next, setNext, "new-password"],
          [text("新しい値（確認）", "Confirm new value"), confirm, setConfirm, "new-password"],
        ].map(([caption, value, setter, autocomplete]) => (
          <label class="field" key={String(caption)}>
            <span>{String(caption)}</span>
            <input
              type={reveal ? "text" : "password"}
              inputMode={signing ? "text" : "numeric"}
              maxLength={signing ? 16 : 4}
              value={String(value)}
              autoComplete={String(autocomplete)}
              spellcheck={false}
              onInput={(event) => {
                (setter as (value: string) => void)(normalize((event.currentTarget as HTMLInputElement).value));
                setError(null);
                setDangerConfirmed(false);
              }}
            />
          </label>
        ))}
      </div>
      <label class="check">
        <input type="checkbox" checked={reveal} onChange={(event) => setReveal(event.currentTarget.checked)} />
        <span>{text("入力を表示", "Show values")}</span>
      </label>
      {error && <p class="form-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !statusesLoaded || retries === 0}>
        {busy ? text("変更中…", "Changing…") : text("変更する", "Change")}
      </button>
      {!statusesLoaded && <p class="note">{text("先に上の「残り回数を読む」を押してください。", "Read the remaining attempts above first.")}</p>}
    </form>
  );
}

export function PinScreen() {
  const [busy, setBusy] = useState(false);
  const values = pinStatuses.value;
  const status = cardStatus.value;

  async function refresh(showNotice = true) {
    setBusy(true);
    signCertificate.value = null;
    signCaCertificate.value = null;
    try {
      applyPinStatuses(await api.pinStatuses());
      if (showNotice) notify("info", text("残り回数をカードから読み取りました。", "Read retry counters from the card."));
    } catch (thrown) {
      notify("error", describe(asAppError(thrown)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="screen pin-screen">
      <h1>{text("PIN 状態・変更", "PIN status & change")}</h1>
      {!status && (
        <div class="empty">
          <p>{text("先にカードへ接続してください。", "Connect to a card first.")}</p>
          <button class="ghost" onClick={() => (screen.value = "card")}>{text("カード画面を開く", "Open Card screen")}</button>
        </div>
      )}
      {status && (
        <>
          <div class="row">
            <button onClick={() => refresh()} disabled={busy}>
              {busy ? text("読み取り中…", "Reading…") : text("残り回数を読む", "Read remaining attempts")}
            </button>
          </div>
          <p class="note">
            {text(
              "この読み取り自体は回数を消費しません。表示は現在の myna pin status と同じ 7 項目です。",
              "Reading counters does not consume an attempt. These are the same seven entries shown by current myna pin status.",
            )}
          </p>
          {values && (
            <div class="panel pin-status-grid">
              {[
                [text("券面入力補助AP 暗証番号", "Input-helper PIN"), values.cardPin, "card"],
                [text("券面入力補助AP 照合番号A", "Input-helper code A"), values.textCodeA, "text A"],
                [text("券面入力補助AP 照合番号B", "Input-helper code B"), values.textCodeB, "text B"],
                [text("券面事項確認AP 照合番号A", "Card-face code A"), values.surfaceCodeA, "visual A"],
                [text("券面事項確認AP 照合番号B", "Card-face code B"), values.surfaceCodeB, "visual B"],
                [text("JPKI 利用者証明用暗証番号", "JPKI authentication PIN"), values.authPin, "auth"],
                [text("JPKI 署名用パスワード", "JPKI signing password"), values.signPin, "sign"],
              ].map(([label, count, alias]) => (
                <Claim key={String(alias)} label={String(label)} tone={counterTone(count as number | null)}>
                  {counterText(count as number | null)} <code>{String(alias)}</code>
                </Claim>
              ))}
            </div>
          )}
          <div class="pin-change-grid">
            <PinChangePanel
              kind="card"
              labelJa="券面入力補助用暗証番号"
              labelEn="Card input-helper PIN"
              retries={values?.cardPin ?? null}
              statusesLoaded={values !== null}
              onChanged={() => refresh(false)}
            />
            <PinChangePanel
              kind="auth"
              labelJa="利用者証明用暗証番号"
              labelEn="JPKI authentication PIN"
              retries={values?.authPin ?? null}
              statusesLoaded={values !== null}
              onChanged={() => refresh(false)}
            />
            <PinChangePanel
              kind="sign"
              labelJa="署名用パスワード"
              labelEn="JPKI signing password"
              retries={values?.signPin ?? null}
              statusesLoaded={values !== null}
              onChanged={() => refresh(false)}
            />
          </div>
        </>
      )}
    </section>
  );
}

function CertificateTable({ certificate }: { certificate: CertificateInfo }) {
  const h = certificate.holder;
  const substitutions = [
    describeSubstitutes("氏名", h.nameSubstitutes),
    describeSubstitutes("住所", h.addressSubstitutes),
  ].filter((s): s is string => s !== null);
  return (
    <>
    {substitutions.length > 0 && (
      <p class="warn-box">
        {substitutions.map((text) => (
          <span key={text}>{text}</span>
        ))}
      </p>
    )}
    <dl class="holder">
      <dt>{LABELS.subject}</dt>
      <dd>{certificate.subject}</dd>
      {h.name && (
        <>
          <dt>氏名</dt>
          <dd>{h.name}</dd>
        </>
      )}
      {h.address && (
        <>
          <dt>住所</dt>
          <dd>{h.address}</dd>
        </>
      )}
      {h.birthDate && (
        <>
          <dt>生年月日</dt>
          <dd>{h.birthDate}</dd>
        </>
      )}
      {h.sex && (
        <>
          <dt>性別</dt>
          <dd>{describeSex(h.sex)}</dd>
        </>
      )}
      <dt>発行者</dt>
      <dd>{certificate.issuer}</dd>
      <dt>有効期間</dt>
      <dd>
        {certificate.notBefore} 〜 {certificate.notAfter}
      </dd>
      <dt>鍵長</dt>
      <dd>{certificate.keyBits} bit</dd>
      <dt>フィンガープリント</dt>
      <dd>
        <code>{certificate.fingerprint}</code>
      </dd>
      {/* Keyed on the fragment, not on the pair inside it: a key on a child of an unkeyed
          fragment is a key within a list of one, which reconciles nothing. */}
      {h.other.map(([oid, value]) => (
        <Fragment key={oid}>
          <dt>{oid}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
    </>
  );
}

// --- Sign ---------------------------------------------------------------------------------------

// One subscription for the life of the module. Registered per mount, the events between an unmount
// and the next mount are lost, and a batch that ran while the signer was reading another tab would
// come back with a progress line frozen at whatever it said when they left.
listen<Progress>("sign-progress", (event) => {
  signProgress.value = event.payload.stage === "done" ? null : event.payload;
}).catch(() => {});

/**
 * Read as `Record<string, string>` rather than as the stage union: which stages exist is decided in
 * Rust, and one this file has not heard of should come out as a vague word rather than as nothing.
 */
const STAGE_LABEL: Record<string, string> = {
  signing: "署名中",
  timestamping: "タイムスタンプ取得中",
  writing: "書き出し中",
};

const PLANNED_LABEL: Record<PlannedOutput["kind"], string> = {
  signature: "署名",
  publicKey: "OpenPGP 公開鍵",
  timestampToken: "タイムスタンプトークン（.tsr）",
};

const SIDE_OUTPUT_LABEL: Record<SideOutput["kind"], string> = {
  publicKey: "OpenPGP 公開鍵（.pubkey.asc）",
  timestampToken: ".tsr",
};

/** Whether this build can put text on the clipboard at all. */
const clipboardAvailable =
  typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";

export function SignScreen() {
  const [subjects, setSubjects] = useState<SigningSubject[] | null>(null);
  // What the card answered when asked just before this confirmation, which is not the same thing as
  // the last number anybody has. A card that declines to say leaves `cardStatus` holding the figure
  // from connection time, and handing that to the dialog would let it decide there is nothing to
  // warn about on the strength of a number this attempt has no evidence for.
  const [askedRetries, setAskedRetries] = useState<number | null>(null);
  const [planned, setPlanned] = useState<PlannedOutput[]>([]);
  // Chosen before the password, and read again after it. A ref rather than state because nothing on
  // screen depends on it and it must not be a render behind when the dialog reports success.
  const pdfOutput = useRef<string | null>(null);
  // The confirmation set is what the modal is showing, and a drop from the desktop lands on the OS
  // window rather than on the page — so the guard has to read the live value, not a captured one.
  const subjectsRef = useRef<SigningSubject[] | null>(null);
  subjectsRef.current = subjects;

  const files = pending.value;
  const isPdf = files.length === 1 && files[0].toLowerCase().endsWith(".pdf");
  const status = cardStatus.value;
  const retries = status?.signPinRetries ?? null;
  const busy = signBusy.value;
  const options = pdfOptions.value;
  const results = signResults.value;
  const sideOutputs = signSideOutputs.value;
  const failure = signingFailure.value;
  const progress = signProgress.value;
  const blockedByTimestamp = signPendingBlocked.value.filter(
    (item) => item.blockedBy.kind === "timestamp",
  );
  const blockedByWrite = signPendingBlocked.value.filter(
    (item) => item.blockedBy.kind === "write",
  );
  // Stopping is not failing. These get their own panel because every sentence in the other two is
  // about something having gone wrong, and none of it is true here.
  const cancelled = signPendingBlocked.value.filter(
    (item) => item.blockedBy.kind === "cancelled",
  );

  function setOptions(patch: Partial<typeof pdfOptions.value>) {
    pdfOptions.value = { ...pdfOptions.value, ...patch };
  }

  useEffect(() => {
    // Signatures can be left waiting by a window that was closed mid-decision. Rust is the one that
    // still holds them, so the list is asked for rather than remembered — except while a run is in
    // flight, whose own outcome is about to say the same thing more completely.
    if (signBusy.value) return;
    api
      .listPending()
      .then((held) => {
        signPendingBlocked.value = held;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Browser-only preview builds do not expose Tauri's window metadata. The desktop WebView does.
    if (!("__TAURI_INTERNALS__" in window)) return;
    // A drop is delivered by the operating system to the window, which sits above the modal: while
    // the confirmation is up, or a run is under way, changing the selection would change the set of
    // files `afterUnlock` reads — and that set has already been shown and agreed to.
    const stop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      if (subjectsRef.current !== null || signBusy.value) return;
      if (event.payload.paths.length === 0) return;
      selectFiles(event.payload.paths);
    });
    return () => {
      stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // What signing would write, asked of the Rust side rather than worked out here: the naming rule
  // lives there and in the CLI already, and a third copy in the window would drift from both.
  useEffect(() => {
    if (isPdf || files.length === 0) {
      setPlanned([]);
      return;
    }
    let cancelled = false;
    api
      .planOutputs({
        paths: files,
        embedCertificate: embedCertificate.value,
        exportPublicKey: exportPublicKey.value,
        cleartext: cleartext.value,
        writeTsr: writeTsr.value,
        tsa: tsa.value,
      })
      .then((plan) => {
        if (!cancelled) setPlanned(plan);
      })
      .catch(() => {
        if (!cancelled) setPlanned([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isPdf,
    files,
    embedCertificate.value,
    exportPublicKey.value,
    cleartext.value,
    writeTsr.value,
    tsa.value,
  ]);

  // Where the signature would land if the signer places it nowhere. Asked of the Rust side rather
  // than worked out here, so what is shown is what the signing path will actually do.
  useEffect(() => {
    if (!isPdf || invisibleSignature.value || options.placed) return;
    let cancelled = false;
    api
      .defaultSignaturePlacement(files[0], options.imagePath)
      .then((placement) => {
        if (cancelled || pdfOptions.value.placed) return;
        pdfOptions.value = {
          ...pdfOptions.value,
          page: placement.page,
          rect: placement.rect,
        };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    isPdf,
    files[0],
    options.imagePath,
    options.reason,
    options.location,
    options.placed,
    invisibleSignature.value,
  ]);

  /**
   * Take a new selection.
   *
   * Every path that changes the files comes through here, because every one of them has to drop the
   * placement: a rectangle dragged onto one PDF describes a page of that PDF, and carrying it over
   * would put the next signature at coordinates nobody chose. The results go too — they describe
   * files that are no longer the ones on screen.
   */
  function selectFiles(paths: string[]) {
    pending.value = [...new Set(paths)];
    resetPdfPlacement();
    signResults.value = [];
    signSideOutputs.value = [];
    signingFailure.value = null;
    signRequested.value = 0;
    signDiscarded.value = 0;
  }

  function removeFileAt(path: string) {
    selectFiles(files.filter((candidate) => candidate !== path));
  }

  async function choose(append: boolean) {
    const picked = await open({
      multiple: true,
      title: append
        ? text("追加で署名するファイルを選ぶ", "Choose more files to sign")
        : text("署名するファイルを選ぶ", "Choose files to sign"),
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    selectFiles(append ? [...files, ...paths] : paths);
  }

  async function chooseImage() {
    const picked = await open({
      multiple: false,
      title: text("ページに描く画像を選ぶ", "Choose an image to place on the page"),
      filters: [{ name: text("画像", "Images"), extensions: ["png", "jpg", "jpeg"] }],
    });
    if (typeof picked === "string") setOptions({ imagePath: picked });
  }

  /** Fold a run's outcome into what the screen shows. */
  async function absorb(outcome: SignOutcome) {
    signResults.value = outcome.written;
    // `outcome.pending` is only what *this* run held back, and the queue belongs to Rust: a run
    // that succeeds after an earlier one was blocked would otherwise drop the earlier signatures
    // off the screen, leaving them unretriable and undiscardable while Rust still holds them.
    signPendingBlocked.value = await api.listPending().catch(() => outcome.pending);
    signingFailure.value = outcome.signingError;
    signSideOutputs.value = outcome.sideOutputs;
    signRequested.value = outcome.requested;
    signDiscarded.value = 0;
    // "署名しました" for a run that signed three of five is the sentence people act on and never
    // revisit; the panel below can say the rest, but the one line at the top has to be true.
    const complete = outcome.written.length === outcome.requested;
    if (complete) notify("info", "署名しました。");
    else notify("warn", "一部のファイルを署名できませんでした。");
  }

  async function decide(items: PendingInfo[], action: PendingAction) {
    if (items.length === 0) return;
    const ids = items.map((item) => item.id);
    signBusy.value = true;
    try {
      const outcome = await api.resolvePending(ids, action);
      // Written to a destination chosen by hand, a signature can land on a path already listed
      // above; the row for it says what is there now, not what was there first.
      signResults.value = [
        ...signResults.value.filter(
          (existing) => !outcome.written.some((fresh) => fresh.output === existing.output),
        ),
        ...outcome.written,
      ];
      // A retry writes the same `.tsr` again, so the newer word about a path replaces the older one
      // rather than sitting beneath it saying the opposite.
      signSideOutputs.value = [
        ...signSideOutputs.value.filter(
          (existing) => !outcome.sideOutputs.some((fresh) => fresh.path === existing.path),
        ),
        ...outcome.sideOutputs,
      ];
      // The queue belongs to Rust and this call touched only part of it, so what is still held is
      // asked for rather than pieced together from the reply.
      signPendingBlocked.value = await api.listPending();
      if (action === "discard") {
        signDiscarded.value += items.length;
        notify("warn", "署名を破棄しました。");
      } else if (outcome.pending.length === 0) {
        notify("info", "保存しました。");
      } else {
        notify("warn", "まだ書き出せていない署名があります。");
      }
    } catch (e) {
      notify("error", describe(asAppError(e)));
    } finally {
      signBusy.value = false;
      signProgress.value = null;
    }
  }

  /**
   * Write held signatures somewhere else.
   *
   * The destinations come from a save dialog, one per signature, and never from anything the page
   * made up: the capability list grants this program no filesystem of its own, and the path the
   * dialog returns is the only one it is allowed to write to.
   */
  async function writeElsewhere(items: PendingInfo[]) {
    const outputs: string[] = [];
    for (const item of items) {
      const chosen = await save({
        title: text(
          `${basename(item.source)} の署名の保存先`,
          `Save signature for ${basename(item.source)}`,
        ),
        defaultPath: item.output,
      });
      if (typeof chosen !== "string") {
        notify("info", "保存先の指定をやめました。署名はそのまま残っています。");
        return;
      }
      outputs.push(chosen);
    }
    await decide(items, { writeTo: { outputs } });
  }

  async function cancelTimestamping() {
    try {
      await api.cancelTimestamping();
      notify("info", "タイムスタンプの取得を中止します。取得中の 1 件は最後まで待ちます。");
    } catch (e) {
      notify("error", describe(asAppError(e)));
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      notify("info", "パスをコピーしました。");
    } catch (e) {
      notify("error", `コピーできませんでした。（${String(e)}）パスを選択してコピーしてください。`);
    }
  }

  /** Gather what is about to be signed, so the password dialog can show it. */
  async function beginSigning() {
    if (busy || files.length === 0) return;

    // A run that cannot reach the authority it was told to use must not cost a card operation: the
    // password and one attempt would be spent before the empty address was noticed.
    if (tsa.value.kind === "custom" && tsa.value.url.trim() === "") {
      notify(
        "error",
        "タイムスタンプの送信先が未入力です。URL を入力するか、送信先を「なし」にしてください。",
      );
      return;
    }

    // The destination first. Asked after the password, a cancelled save dialog ends the run in
    // silence with the card unlocked and the 基本4情報 on screen, having signed nothing.
    if (isPdf) {
      const output = await save({
        title: text("署名した PDF の保存先", "Save signed PDF"),
        defaultPath: files[0].replace(/\.pdf$/i, "") + ".signed.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof output !== "string") return;
      pdfOutput.current = output;
    } else {
      pdfOutput.current = null;
    }

    try {
      const gathered: SigningSubject[] = [];
      for (const path of files) {
        // The whole path, not the name: the dialog is where a signer decides, and two files called
        // the same thing in two folders are one line otherwise.
        gathered.push({ label: path, digest: await api.documentDigest(path) });
      }

      // §11-6: the count comes from the card immediately before VERIFY, never from the reading taken
      // at connection. A remembered five is exactly the number that leads to the fifth wrong try.
      let observed: number | null;
      try {
        observed = await api.signPinRetries();
      } catch (e) {
        // Nothing is written back on a failed read: the card is not in a state to be signed with
        // anyway, and the last number it did give is still the last thing it said. The run stops
        // here rather than going to VERIFY on a count nobody has.
        notify("error", describe(asAppError(e)));
        return;
      }
      setSignPinRetries(observed);
      if (observed === 0) {
        notify("error", PIN_BLOCKED.sentence);
        return;
      }

      setAskedRetries(observed);
      setSubjects(gathered);
    } catch (e) {
      notify("error", describe(asAppError(e)));
    }
  }

  async function afterUnlock(certificate: CertificateInfo) {
    // The certificate carries the 基本4情報; keeping it lets the card screen show what the
    // signature will disclose, and saves asking for the password again.
    signCertificate.value = certificate;
    try {
      signCaCertificate.value = await api.signCaCertificate();
    } catch {
      // A missing CA copy does not make the holder certificate or private-key operation invalid.
      signCaCertificate.value = null;
    }
    setSubjects(null);
    signBusy.value = true;
    try {
      // VERIFY succeeded, so the card has put its counter back. Leaving the number from the failed
      // attempts on screen would understate what is left — a lie in the direction that makes people
      // stop using a card that is perfectly fine.
      try {
        setSignPinRetries(await api.signPinRetries());
      } catch {
        // The run is what the password was spent on; a count that cannot be re-read does not stop it.
      }

      if (isPdf) {
        const output = pdfOutput.current;
        if (!output) {
          notify("error", "保存先が決まっていません。もう一度「署名する」を押してください。");
          return;
        }
        await absorb(
          await api.signPdf({
            path: files[0],
            output,
            reason: options.reason || null,
            location: options.location || null,
            invisible: invisibleSignature.value,
            // Always the rectangle that was on screen, whether the signer dragged it or left the
            // default where it was. Sending `null` here would let the Rust side work the default
            // out again from the *real* panel, which is a little narrower than the preview — and
            // the signature would end up somewhere other than the box the user was looking at.
            appearance: options.rect
              ? { page: options.page, rect: options.rect, imagePath: options.imagePath }
              : null,
            tsa: tsa.value,
          }),
        );
      } else {
        await absorb(
          await api.signFiles({
            paths: files,
            embedCertificate: embedCertificate.value,
            exportPublicKey: exportPublicKey.value,
            cleartext: cleartext.value,
            writeTsr: writeTsr.value,
            tsa: tsa.value,
          }),
        );
      }
    } catch (e) {
      notify("error", describe(asAppError(e)));
    } finally {
      signBusy.value = false;
      signProgress.value = null;
    }
  }

  const publicKeyOutput = planned.find((item) => item.kind === "publicKey") ?? null;
  // The planned name when Rust has given one, and the rule it follows otherwise: both the checkbox
  // and the confirmation name the file that will appear beside the originals, because "a public
  // key, somewhere" is not something anybody can decide about.
  const publicKeyName = publicKeyOutput
    ? basename(publicKeyOutput.path)
    : files.length > 0
      ? `${basename(files[0])}.pubkey.asc`
      : null;
  const disclosure: Disclosure = isPdf
    ? { kind: "pdf", nameOnPage: !invisibleSignature.value, publicKey: false }
    : {
        kind: "pgp",
        embed: embedCertificate.value,
        publicKey: exportPublicKey.value,
        publicKeyName: exportPublicKey.value ? publicKeyName : null,
      };

  const unsignedCount = failure ? 1 + failure.skipped.length : 0;
  const accounted =
    results.length +
    blockedByTimestamp.length +
    blockedByWrite.length +
    cancelled.length +
    unsignedCount +
    signDiscarded.value;
  // The heading has to add up, so the total is whichever is larger: a queue restored from an earlier
  // session can hold more than this run asked for.
  const total = Math.max(signRequested.value, accounted);
  const resultParts: string[] = [];
  if (results.length > 0) resultParts.push(`${results.length} 件を書き出し`);
  if (blockedByTimestamp.length > 0) {
    resultParts.push(`${blockedByTimestamp.length} 件はタイムスタンプ待ち`);
  }
  if (blockedByWrite.length > 0) resultParts.push(`${blockedByWrite.length} 件は書き出し待ち`);
  if (cancelled.length > 0) resultParts.push(`${cancelled.length} 件は取得を中止`);
  if (unsignedCount > 0) resultParts.push(`${unsignedCount} 件は未署名`);
  if (signDiscarded.value > 0) resultParts.push(`${signDiscarded.value} 件は破棄`);
  if (total > accounted) resultParts.push(`${total - accounted} 件は結果が分かりません`);

  return (
    <section class="screen">
      <h1>署名</h1>

      {!status ? (
        <div class="status-block">
          <p>
            <strong>カードが接続されていません。</strong>署名するにはカードの接続が必要です。
          </p>
          <div class="row">
            <button onClick={() => connectCard(null)} disabled={cardBusy.value}>
              接続
            </button>
            <button class="ghost" onClick={() => (screen.value = "card")}>
              カード画面を開く
            </button>
          </div>
        </div>
      ) : !status.hasSignCertificate ? (
        <div class="status-block">
          <p>{NO_SIGN_CERTIFICATE}</p>
        </div>
      ) : retries === 0 ? (
        <div class="status-block">
          <p>{PIN_BLOCKED.sentence}</p>
        </div>
      ) : (
        <div class="status-block">
          <p>
            {status.reader} ／ 署名用パスワード {retriesSummary(retries)}
          </p>
          <p class="note">{retriesConsequence(retries)}</p>
        </div>
      )}

      {signCertificate.value && (
        <div class="status-block">
          <p>
            <strong>
              このカードは、切断して状態をリセットするか、リーダーから取り外すまで、署名鍵のロックが解除されたままです。
            </strong>
            接続中は本アプリがカードを占有するため、ほかのアプリはこのカードを使えません。席を離れるときは、下のボタンで切断するか、カードをリーダーから取り外してください。取り外すと給電が切れ、解錠された状態も失われます。
          </p>
          <div class="row">
            <button class="ghost" onClick={disconnectCard} disabled={cardBusy.value || busy}>
              切断
            </button>
          </div>
        </div>
      )}

      <div class="row">
        <button onClick={() => choose(false)} disabled={busy}>
          ファイルを選ぶ
        </button>
        <button
          onClick={beginSigning}
          disabled={
            busy ||
            files.length === 0 ||
            !status ||
            !status.hasSignCertificate ||
            retries === 0
          }
        >
          署名する
        </button>
      </div>

      {files.length === 0 ? (
        <div class="empty">
          <p>署名するファイルが選ばれていません。</p>
          <p class="note">
            「ファイルを選ぶ」を押すか、この画面にファイルをドロップしてください。PDF を 1 つだけ選ぶと、その中に署名を埋め込みます。
          </p>
        </div>
      ) : (
        <div class="panel">
          <h2>署名するファイル</h2>
          <ul class="planned">
            {files.map((path) => {
              const output =
                planned.find((item) => item.kind === "signature" && item.source === path) ?? null;
              const folder = dirname(path);
              return (
                <li key={path} class="planned-row">
                  <div>
                    <code>{basename(path)}</code>
                    {output && (
                      <>
                        {" → "}
                        <code>{basename(output.path)}</code>
                      </>
                    )}
                    {folder && <small class="chain">{folder}</small>}
                    {isPdf && (
                      <small class="chain">
                        保存先は「署名する」を押したときに選びます。元のファイルは変更しません。
                      </small>
                    )}
                  </div>
                  <div class="row">
                    {output?.exists && (
                      <strong class="planned-badge">既存のファイルを上書きします</strong>
                    )}
                    <button class="ghost small" onClick={() => removeFileAt(path)} disabled={busy}>
                      外す
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div class="row">
            <button class="ghost" onClick={() => choose(true)} disabled={busy}>
              さらに追加
            </button>
          </div>
          {!isPdf && files.some((path) => path.toLowerCase().endsWith(".pdf")) && (
            <p class="note">
              複数のファイルを選んでいるため、PDF も OpenPGP 署名（.asc）になります。PDF の中に署名を埋め込むには、その 1 つだけを選んでください。
            </p>
          )}
        </div>
      )}

      {!isPdf && planned.some((item) => item.kind !== "signature") && (
        <div class="panel">
          <h2>このほかに作成されるファイル</h2>
          <ul class="planned">
            {planned
              .filter((item) => item.kind !== "signature")
              .map((item) => (
                <li key={item.path} class="planned-row">
                  <div>
                    <code>{basename(item.path)}</code>
                    <small class="chain">
                      {PLANNED_LABEL[item.kind]}
                      {item.kind === "publicKey" && " — 先頭のファイルの隣に 1 つだけ作ります"}
                    </small>
                    {dirname(item.path) && <small class="chain">{dirname(item.path)}</small>}
                  </div>
                  {item.exists && (
                    <strong class="planned-badge">既存のファイルを上書きします</strong>
                  )}
                </li>
              ))}
          </ul>
        </div>
      )}

      {files.length > 0 && !isPdf && (
        <div class="panel">
          <h2>OpenPGP 署名（.asc）</h2>
          <p class="note">
            {cleartext.value
              ? "本文と署名を 1 つにまとめた〈元のファイル名〉.asc を作ります。元のファイルは 1 バイトも変更しません。相手には .asc だけを渡せば検証できます。"
              : "元のファイルは 1 バイトも変更しません。同じ場所に〈元のファイル名〉.asc を作ります。相手には元のファイルと .asc の両方を渡してください。"}
          </p>
          <label class="check">
            <input
              type="checkbox"
              checked={embedCertificate.value}
              onChange={(e) =>
                (embedCertificate.value = (e.target as HTMLInputElement).checked)
              }
            />
            <span>
              署名用電子証明書を埋め込む
              <small>
                受け取った相手が単独で検証できるようになりますが、
                <strong>氏名・住所・生年月日・性別が開示されます</strong>。
              </small>
            </span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={exportPublicKey.value}
              onChange={(e) =>
                (exportPublicKey.value = (e.target as HTMLInputElement).checked)
              }
            />
            <span>
              OpenPGP 公開鍵も書き出す
              <small>
                gpg で検証できるようになります。
                {publicKeyName ?? "〈先頭ファイル名〉.pubkey.asc"}{" "}
                を原本の隣に作ります。この鍵の User ID
                には証明書の氏名が入るため、証明書を埋め込まない場合でも開示されます。
              </small>
            </span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={cleartext.value}
              onChange={(e) => (cleartext.value = (e.target as HTMLInputElement).checked)}
            />
            <span>
              クリアテキスト署名にする
              <small>
                本文と署名を 1 つの読めるファイルにまとめます。テキストファイルにのみ使えます。各行の末尾の空白は署名できないため取り除かれます。
              </small>
            </span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={writeTsr.value}
              onChange={(e) => (writeTsr.value = (e.target as HTMLInputElement).checked)}
              disabled={tsa.value.kind === "none"}
            />
            <span>
              タイムスタンプトークンを .tsr としても書き出す
              <small>
                openssl ts -verify で単体検証できます。
                {tsa.value.kind === "none" &&
                  "タイムスタンプが「なし」のときは、チェックが入っていても .tsr は作られません。"}
              </small>
            </span>
          </label>
        </div>
      )}

      {isPdf && (
        <div class="panel">
          <h2>PDF 署名</h2>
          <p class="warn-box">
            この PDF には署名用電子証明書が必ず同梱され、受け取った人は氏名・住所・生年月日・性別を読み出せます。外す選択肢はありません（外すと誰も検証できなくなるためです）。署名欄には氏名と住所が印字されます。
          </p>
          <label class="field">
            <span>理由</span>
            <input
              value={options.reason}
              onInput={(e) => setOptions({ reason: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field">
            <span>場所</span>
            <input
              value={options.location}
              onInput={(e) => setOptions({ location: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={invisibleSignature.value}
              onChange={(e) =>
                (invisibleSignature.value = (e.target as HTMLInputElement).checked)
              }
            />
            <span>
              署名をページに表示しない
              <small>
                既定では、証明書の氏名・住所と日時を記した署名欄がページに描かれます。これを選ぶと、ページ上には何も現れません。ただし生年月日・性別を含む証明書は、枠の有無にかかわらず文書に入ります。見えないだけで、隠されているわけではありません。
              </small>
            </span>
          </label>

          <div class="row">
            <button class="ghost" onClick={chooseImage} disabled={invisibleSignature.value}>
              自分の画像を使う
            </button>
            {options.imagePath && (
              <>
                <code>{basename(options.imagePath)}</code>
                <button class="ghost small" onClick={() => setOptions({ imagePath: null })}>
                  外す
                </button>
              </>
            )}
          </div>
          {invisibleSignature.value && (
            <p class="note">
              「署名をページに表示しない」を選んでいる間は、ページに何も描かないため画像も使いません。
            </p>
          )}
          {!invisibleSignature.value && (
            <PdfPlacement
              path={files[0]}
              imagePath={options.imagePath}
              page={options.page}
              rect={options.rect}
              provisional={!options.placed}
              onChange={(page, rect, chosen = true) =>
                setOptions({ page, rect, placed: chosen })
              }
            />
          )}
          <p class="note">
            署名は追記（インクリメンタル更新）で書き込みます。元の PDF のバイト列は変えないため、既存の署名は壊れません。
          </p>
        </div>
      )}

      <TsaPicker />

      {progress && (
        <div class="progress-row">
          <strong>{STAGE_LABEL[progress.stage] ?? "処理中"}</strong>
          <span>
            {progress.index + 1}/{progress.total}
          </span>
          {progress.path && <code>{basename(progress.path)}</code>}
          <progress value={progress.index + 1} max={progress.total} />
          {progress.stage === "timestamping" && (
            <>
              <button class="ghost small" onClick={cancelTimestamping}>
                中止
              </button>
              <small class="chain">
                応答が無いときは 1 件あたり最大 15 秒かかります。中止しても、取得中の 1 件は最後まで待ちます。
              </small>
            </>
          )}
        </div>
      )}

      {failure && (
        <div class="panel">
          <h2>署名できなかったファイルがあります</h2>
          <p class="warn-box">
            <strong>{failure.path} の署名に失敗したため、そこで中断しました。</strong>
          </p>
          <p class="error">{failure.message}</p>
          {failure.skipped.length > 0 && (
            <>
              <p class="note">カードに送っていないファイル:</p>
              <ul class="files">
                {failure.skipped.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p class="note">再実行には署名用パスワードの再入力が必要です。</p>
        </div>
      )}

      {blockedByTimestamp.length > 0 && (
        <PendingPanel
          items={blockedByTimestamp}
          kind="timestamp"
          busy={busy}
          onDecide={decide}
          onWriteElsewhere={writeElsewhere}
        />
      )}

      {blockedByWrite.length > 0 && (
        <PendingPanel
          items={blockedByWrite}
          kind="write"
          busy={busy}
          onDecide={decide}
          onWriteElsewhere={writeElsewhere}
        />
      )}

      {cancelled.length > 0 && (
        <PendingPanel
          items={cancelled}
          kind="cancelled"
          busy={busy}
          onDecide={decide}
          onWriteElsewhere={writeElsewhere}
        />
      )}

      {total > 0 && (
        <div class="panel">
          <h2>
            結果（{total} 件中 {resultParts.join("、")}）
          </h2>
          {results.map((result) => (
            <div key={result.output} class="result">
              <Claim label="出力" tone="ok" state={null}>
                <code style={clipboardAvailable ? undefined : { userSelect: "all" }}>
                  {result.output}
                </code>
                {clipboardAvailable && (
                  <button class="copy" onClick={() => copyPath(result.output)}>
                    パスをコピー
                  </button>
                )}
              </Claim>
              <TimestampClaim timestamp={result.timestamp} />
            </div>
          ))}
          {sideOutputs.map((item) =>
            item.written ? (
              <Claim key={item.path} label={SIDE_OUTPUT_LABEL[item.kind]} tone="ok" state={null}>
                <code style={clipboardAvailable ? undefined : { userSelect: "all" }}>
                  {item.path}
                </code>
              </Claim>
            ) : (
              <Claim key={item.path} label={SIDE_OUTPUT_LABEL[item.kind]} tone="warn">
                {SIDE_OUTPUT_LABEL[item.kind]} は書けませんでした（署名そのものは保存済みです）。
                {item.error && <small class="chain">{item.error}</small>}
              </Claim>
            ),
          )}
        </div>
      )}

      {subjects && (
        <PasswordDialog
          subjects={subjects}
          retries={askedRetries}
          disclosure={disclosure}
          tsaDestination={tsaDestination(tsa.value)}
          onUnlocked={afterUnlock}
          onCancel={() => setSubjects(null)}
          onRetriesObserved={(observed) => setSignPinRetries(observed)}
        />
      )}
    </section>
  );
}

/**
 * Signatures that exist but have not reached the disk, and what can be done with them.
 *
 * Split by what is holding them up, because the answers differ. A timestamp can be waited for again
 * or given up on; a destination that refused the write will refuse it again in exactly the same way,
 * so the option that pretends otherwise is not offered.
 */
function PendingPanel({
  items,
  kind,
  busy,
  onDecide,
  onWriteElsewhere,
}: {
  items: PendingInfo[];
  kind: "timestamp" | "write" | "cancelled";
  busy: boolean;
  onDecide: (items: PendingInfo[], action: PendingAction) => void;
  onWriteElsewhere: (items: PendingInfo[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const reasons = [
    ...new Set(
      items.map((item) => ("message" in item.blockedBy ? item.blockedBy.message : "")),
    ),
  ].filter((reason) => reason !== "");

  return (
    <div class="panel">
      <h2>
        {kind === "timestamp"
          ? "タイムスタンプを取得できませんでした"
          : kind === "write"
            ? "署名を書き出せませんでした"
            : "タイムスタンプの取得を中止しました"}
      </h2>
      {kind === "timestamp" ? (
        <p class="warn-box">
          <strong>署名そのものは作成済みです。</strong>
          まだファイルに書き出していないだけなので、失われていません。再試行しても、カードの操作やパスワードの再入力は必要ありません。
        </p>
      ) : kind === "write" ? (
        <p class="warn-box">
          <strong>署名そのものは作成済みです。</strong>{reasons.join(" / ")}
        </p>
      ) : (
        <p class="warn-box">
          <strong>署名そのものは作成済みです。</strong>
          中止したのはタイムスタンプの取得だけで、署名は失われていません。再試行しても、カードの操作やパスワードの再入力は必要ありません。
        </p>
      )}
      <ul class="planned">
        {items.map((item) => (
          <li key={item.id} class="planned-row">
            {kind === "write" ? (
              <div>
                {/* The whole path, not the name. What refused the write is the folder, and the
                    folder is the part a name leaves out. */}
                <code>{item.output}</code>
                <small class="chain">{basename(item.source)} の署名</small>
              </div>
            ) : (
              <div>
                <code>{basename(item.source)}</code>
                {" → "}
                <code>{basename(item.output)}</code>
                {"message" in item.blockedBy && (
                  <small class="chain">{item.blockedBy.message}</small>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div class="row">
        <button onClick={() => onDecide(items, "retry")} disabled={busy}>
          再試行
        </button>
        {kind !== "write" ? (
          <button
            class="ghost"
            onClick={() => onDecide(items, "writeWithoutTimestamp")}
            disabled={busy}
          >
            タイムスタンプなしで保存
          </button>
        ) : (
          <button class="ghost" onClick={() => onWriteElsewhere(items)} disabled={busy}>
            別の場所に保存…
          </button>
        )}
      </div>
      {kind === "timestamp" && (
        <p class="note">
          タイムスタンプなしで保存した署名は、証明書の有効期限が切れると署名時点で有効だったことを示せなくなります。
        </p>
      )}
      {/* Set apart from the row above: this is the one button here that cannot be undone, and eight
          pixels from "save" is where a slip lands on it. */}
      <div style={{ marginTop: "var(--sp-5)" }}>
        {confirming ? (
          <div class="warn-box">
            <p>
              作成済みの署名 {items.length}{" "}
              件を破棄します。取り消せません。同じ署名を作り直すには、
              もう一度パスワードを入力してカードで署名する必要があります。
            </p>
            <div class="row">
              <button class="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                やめる
              </button>
              <button
                class="ghost destructive"
                onClick={() => {
                  setConfirming(false);
                  onDecide(items, "discard");
                }}
                disabled={busy}
              >
                破棄する
              </button>
            </div>
          </div>
        ) : (
          <button class="ghost destructive" onClick={() => setConfirming(true)} disabled={busy}>
            署名を破棄
          </button>
        )}
      </div>
    </div>
  );
}

// --- Verify -------------------------------------------------------------------------------------

/**
 * A verification and what it was of.
 *
 * One value, not two states: with a separate `pgp` and `pdf`, a failure that only cleared one of
 * them left the previous file's "✓ 一致 / 署名者 山田太郎" on screen under a banner about a
 * different file. The path travels with the result so that the panel can name what it is about.
 */
type VerifyOutcome =
  | { kind: "pgp"; signaturePath: string; documentPath: string; result: PgpVerification }
  | { kind: "pdf"; path: string; signatures: PdfSignatureVerification[] }
  | { kind: "error"; path: string; message: string };

interface VerifyEntry {
  id: number;
  at: string;
  outcome: VerifyOutcome;
}

/**
 * What is on screen, what was verified before it, and which files are in the two slots.
 *
 * Module scope, like the signing run: the toggle that decides whether the JPKI test hierarchy is
 * accepted lives on the settings screen, so reaching it means leaving this one. Held in the
 * component, the result would already be gone by the time the toggle was touched — and the rule
 * that a result must not outlive the policy it was computed under would have nothing to enforce.
 */
const verifySignaturePath = signal<string | null>(null);
const verifyDocumentPath = signal<string | null>(null);
const verifyOutcome = signal<VerifyOutcome | null>(null);
const verifyHistory = signal<VerifyEntry[]>([]);
/** The setting the results on screen were computed under. */
const verifiedUnderTestHierarchy = signal(acceptTestHierarchy.value);

function verifiedPath(outcome: VerifyOutcome): string {
  return outcome.kind === "pgp" ? outcome.signaturePath : outcome.path;
}

/**
 * Whether a certificate can be said to name whoever signed *this* document, and why not when it
 * cannot.
 *
 * `coversWholeFile` is deliberately not one of the conditions. A revision appended after a
 * signature is how a second signer signs the same document, and refusing to name the first signer
 * over it would break the one thing PDF signatures exist to allow. It is reported
 * as its own claim instead.
 *
 * Worked out once and used twice — on the screen and in the exported text — because a file that
 * names somebody the window would not is the worse half of the pair being believed.
 */
function pdfAttribution(signature: PdfSignatureVerification): ReportSigner {
  const bound =
    signature.signatureVerified &&
    signature.documentDigestMatches &&
    signature.byteRangeSound &&
    signature.signingCertificateBound;
  const unboundReason = !signature.signatureVerified
    ? "署名が検証できないため、証明書の氏名は表示しません"
    : !signature.documentDigestMatches
      ? "この文書は署名対象と異なるため、証明書の氏名は表示しません"
      : !signature.byteRangeSound
        ? "署名されていない領域があり、画面上の文書が署名対象と同じとは言えないため、証明書の氏名は表示しません"
        : !signature.signingCertificateBound
          ? "署名者情報がこの証明書を指していないため、証明書の氏名は表示しません"
          : null;
  return { certificate: signature.certificate, bound, unboundReason };
}

/**
 * The same question for a detached OpenPGP signature.
 *
 * Two conditions rather than one: a signature can verify against a key that is not the key in the
 * certificate beside it, and then the certificate names somebody who did not sign this (§7.1-2).
 */
function pgpAttribution(verification: PgpVerification): ReportSigner {
  const bound = verification.signatureVerified && verification.keyMatchesCertificate;
  const unboundReason = !verification.signatureVerified
    ? "署名が検証できないため、証明書の氏名は表示しません"
    : !verification.keyMatchesCertificate
      ? "この署名を作った鍵は証明書の鍵と一致しないため、証明書の氏名は表示しません"
      : null;
  return { certificate: verification.certificate, bound, unboundReason };
}

/**
 * The text file's lines.
 *
 * The title and the two disclaimers are added on the Rust side, where the caller cannot leave them
 * out. What is added here is what the screen shows above the claims — which files this was about —
 * because a result with no subject is a result about whatever the reader assumes.
 */
function reportFor(outcome: VerifyOutcome, includePersonalDetails: boolean): string[] {
  if (outcome.kind === "error") return [];
  if (outcome.kind === "pgp") {
    return [
      `検証対象（署名）: ${outcome.signaturePath}`,
      `検証対象（原本）: ${outcome.documentPath}`,
      "",
      ...reportLines(pgpClaims(outcome.result), pgpAttribution(outcome.result), {
        includePersonalDetails,
      }),
    ];
  }
  const lines = [`検証対象: ${outcome.path}`, ""];
  if (outcome.signatures.length === 0) {
    lines.push(
      "署名フィールドが 1 つも見つかりませんでした。",
      "ページに印影やサインの画像があっても、それは電子署名ではありません。",
    );
    return lines;
  }
  outcome.signatures.forEach((signature, index) => {
    lines.push(
      ...reportLines(pdfClaims(signature), pdfAttribution(signature), {
        heading: `署名 ${index + 1}${signature.fieldName ? `（${signature.fieldName}）` : ""}`,
        includePersonalDetails,
      }),
      "",
    );
  });
  return lines;
}

/**
 * What a past run can be reduced to in one line.
 *
 * Only failure is summarisable, and the asymmetry is deliberate. "署名が一致しません" is complete on
 * its own — nothing else about the file changes what it means. There is no matching sentence for
 * success: this program cannot say a signature is valid (§7.4), and a signer's name in a list, away
 * from the claims that qualify it, is precisely the summary that would be read as one.
 */
function historySummary(outcome: VerifyOutcome): string | null {
  if (outcome.kind === "error") return outcome.message;
  if (outcome.kind === "pgp") {
    return outcome.result.signatureVerified ? null : "署名が一致しません";
  }
  if (outcome.signatures.length === 0) return "署名が見つかりません";
  const unsound = outcome.signatures.filter(
    (signature) =>
      !signature.signatureVerified ||
      !signature.documentDigestMatches ||
      !signature.byteRangeSound,
  ).length;
  return unsound > 0 ? `${unsound} 件の署名に問題があります` : null;
}

export function VerifyScreen() {
  const [busy, setBusy] = useState(false);
  // Deliberately not lifted, so it goes back to off. The choice to write an address into a text
  // file belongs to the export it was made for, not to every export after it.
  const [includePersonalDetails, setIncludePersonalDetails] = useState(false);
  const signaturePath = verifySignaturePath.value;
  const documentPath = verifyDocumentPath.value;
  const outcome = verifyOutcome.value;
  const history = verifyHistory.value;
  const testHierarchy = acceptTestHierarchy.value;

  const slotIsPdf = signaturePath?.toLowerCase().endsWith(".pdf") ?? false;
  const missing = !signaturePath
    ? "署名ファイル（.asc / .sig）または署名済み PDF を選んでください。"
    : !slotIsPdf && !documentPath
      ? "分離署名（.asc / .sig）の検証には、署名対象の原本も必要です。"
      : null;

  useEffect(() => {
    // A result computed under one trust policy must not sit on screen under another: with the test
    // hierarchy accepted, "ルートまで到達" means something else entirely. Verifying costs no card,
    // no password and no network, so asking for the file again costs nothing worth keeping a stale
    // answer for. Compared rather than cleared outright, because this also runs on every mount, and
    // that is what catches the toggle being flipped on the settings screen while this one was away.
    if (verifiedUnderTestHierarchy.value === testHierarchy) return;
    verifiedUnderTestHierarchy.value = testHierarchy;
    verifyOutcome.value = null;
    verifyHistory.value = [];
  }, [testHierarchy]);

  useEffect(() => {
    // Keep the web UI independently previewable; native file drops are attached inside Tauri only.
    if (!("__TAURI_INTERNALS__" in window)) return;
    // Dropping onto this screen fills a slot and stops there. Which slot a file belongs in is a
    // guess from its extension, and a guess is not enough to start a verification whose subject the
    // reader has not seen named.
    const stop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      if (paths.length === 0) return;
      const isSignature = (path: string) => /\.(asc|sig|pdf)$/i.test(path);
      const signature = paths.find(isSignature) ?? null;
      const document = paths.find((path) => path !== signature) ?? null;
      if (signature) verifySignaturePath.value = signature;
      if (document) verifyDocumentPath.value = document;
      if (!signature && !document) return;
      if (!signature) {
        notify(
          "info",
          "原本の欄に入れました。署名ファイル（.asc / .sig）または署名済み PDF も選んでください。",
        );
      }
    });
    return () => {
      stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  function show(next: VerifyOutcome) {
    verifyOutcome.value = next;
    verifyHistory.value = [
      {
        id: (verifyHistory.value[0]?.id ?? 0) + 1,
        at: formatJst(new Date().toISOString()),
        outcome: next,
      },
      ...verifyHistory.value,
    ];
  }

  async function pickSignature() {
    const picked = await open({
      multiple: false,
      // macOS shows no filter name in the panel, so the title is the only place this can be said.
      title: text(
        "署名ファイル（.asc / .sig）または署名済み PDF を選ぶ",
        "Choose a signature file (.asc / .sig) or signed PDF",
      ),
      filters: [{
        name: text("署名ファイル・署名済み PDF", "Signature files and signed PDFs"),
        extensions: ["asc", "sig", "pdf"],
      }],
    });
    if (typeof picked === "string") verifySignaturePath.value = picked;
  }

  async function pickDocument() {
    const picked = await open({
      multiple: false,
      title: text("署名対象の原本を選ぶ", "Choose the signed original file"),
    });
    if (typeof picked === "string") verifyDocumentPath.value = picked;
  }

  async function run() {
    if (!signaturePath || missing) return;
    setBusy(true);
    try {
      if (slotIsPdf) {
        const signatures = await api.verifyPdf(signaturePath, acceptTestHierarchy.value);
        show({ kind: "pdf", path: signaturePath, signatures });
      } else if (documentPath) {
        const result = await api.verifyDetached(
          signaturePath,
          documentPath,
          acceptTestHierarchy.value,
        );
        show({ kind: "pgp", signaturePath, documentPath, result });
      }
    } catch (e) {
      // The failure replaces what was on screen. A banner over the previous file's verdict is two
      // statements about two files, read as one statement about this one.
      const message = describe(asAppError(e));
      show({ kind: "error", path: signaturePath, message });
      notify("error", message);
    } finally {
      setBusy(false);
    }
  }

  async function exportResult() {
    if (!outcome || outcome.kind === "error") return;
    const path = await save({
      title: text("検証結果の保存先", "Save verification report"),
      defaultPath: `${basename(verifiedPath(outcome))}-${text("検証結果", "verification-result")}.txt`,
      filters: [{ name: text("テキスト", "Text"), extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.exportVerification(
        path,
        reportFor(outcome, includePersonalDetails).map((line) => translateReportLine(line)),
        locale.value,
      );
      notify("info", "検証結果をテキストで書き出しました。");
    } catch (e) {
      notify("error", describe(asAppError(e)));
    }
  }

  return (
    <section class="screen">
      <h1>検証</h1>

      {testHierarchy && (
        <div class="warn-box">
          <p>
            <strong>JPKI テスト階層を受け入れる設定が ON です。</strong>
            テストカードの署名も「ルートまで到達」と表示されます。
            テストカードは実在の本人のマイナンバーカードではありません。
          </p>
          <div class="row">
            <button class="ghost small" onClick={() => (acceptTestHierarchy.value = false)}>
              OFF に戻す
            </button>
          </div>
        </div>
      )}

      <div class="panel">
        <h2>検証するファイル</h2>
        <ul class="planned">
          <li class="planned-row">
            <div>
              <strong>署名ファイル</strong>
              <small class="chain">.asc / .sig、または署名済み PDF</small>
              {signaturePath ? (
                <code>{signaturePath}</code>
              ) : (
                <small class="chain">未選択</small>
              )}
            </div>
            <div class="row">
              <button class="ghost" onClick={pickSignature} disabled={busy}>
                選ぶ…
              </button>
              {signaturePath && (
                <button
                  class="ghost small"
                  onClick={() => (verifySignaturePath.value = null)}
                  disabled={busy}
                >
                  外す
                </button>
              )}
            </div>
          </li>
          <li class="planned-row">
            <div>
              <strong>原本</strong>
              <small class="chain">
                {slotIsPdf
                  ? "署名済み PDF は原本を必要としません（PDF そのものが原本です）。"
                  : "分離署名（.asc / .sig）が署名したファイルそのもの"}
              </small>
              {!slotIsPdf &&
                (documentPath ? (
                  <code>{documentPath}</code>
                ) : (
                  <small class="chain">未選択</small>
                ))}
            </div>
            <div class="row">
              <button class="ghost" onClick={pickDocument} disabled={busy || slotIsPdf}>
                選ぶ…
              </button>
              {documentPath && !slotIsPdf && (
                <button
                  class="ghost small"
                  onClick={() => (verifyDocumentPath.value = null)}
                  disabled={busy}
                >
                  外す
                </button>
              )}
            </div>
          </li>
        </ul>
        <div class="row">
          <button onClick={run} disabled={busy || missing !== null}>
            検証する
          </button>
        </div>
        {missing && (
          <div class="status-block">
            <p>{missing}</p>
          </div>
        )}
      </div>
      {outcome === null && (
        <div class="empty">
          <p>
            <strong>この画面で分かること</strong>
          </p>
          <ul style={{ display: "inline-block", textAlign: "left" }}>
            <li>その署名が、表示している証明書の鍵で作られたものかどうか</li>
            <li>署名の対象になったファイルが、署名の後で変わっていないかどうか</li>
            <li>証明書が J-LIS のルートまでつながるかどうか</li>
            <li>タイムスタンプがあるかどうか、あるならその時刻</li>
          </ul>
          <p>
            <strong>この画面で分からないこと</strong>
          </p>
          <p class="note">
            証明書が失効していないかどうかは確認しません。本アプリは JPKI
            失効情報サービスを参照しないため、失効した証明書による署名でも、この画面の表示は変わりません。
          </p>
          <p class="note">検証にカード・パスワード・通信は必要ありません。</p>
        </div>
      )}

      {outcome?.kind === "error" && (
        <div class="panel">
          <h2>検証できませんでした</h2>
          <dl class="holder">
            <dt>検証対象</dt>
            <dd>
              <code>{outcome.path}</code>
            </dd>
          </dl>
          <p class="error">{outcome.message}</p>
        </div>
      )}

      {outcome?.kind === "pgp" && (
        <div class="panel">
          <h2>OpenPGP 署名の検証</h2>
          <dl class="holder">
            <dt>検証対象（署名）</dt>
            <dd>
              <code>{outcome.signaturePath}</code>
            </dd>
            <dt>検証対象（原本）</dt>
            <dd>
              <code>{outcome.documentPath}</code>
            </dd>
          </dl>
          <VerdictGroups
            claims={pgpClaims(outcome.result)}
            bound={pgpAttribution(outcome.result).bound}
          />
          <Signer {...pgpAttribution(outcome.result)} />
        </div>
      )}

      {outcome?.kind === "pdf" && (
        <>
          <div class="panel">
            <h2>PDF 署名の検証</h2>
            <dl class="holder">
              <dt>検証対象</dt>
              <dd>
                <code>{outcome.path}</code>
              </dd>
            </dl>
            {outcome.signatures.length === 0 && (
              <>
                <Claim label="署名" tone="bad">
                  署名フィールドが 1 つも見つかりませんでした
                </Claim>
                <p class="warn-box">
                  ページに印影やサインの画像があっても、それは電子署名ではありません。
                  誰が署名したか、作成後に変更されていないかは確認できません。
                </p>
              </>
            )}
          </div>
          {outcome.signatures.map((signature, index) => (
            <div class="panel" key={signature.fieldName ?? index}>
              <h2>
                署名 {index + 1}
                {signature.fieldName ? `（${signature.fieldName}）` : ""}
              </h2>
              <VerdictGroups
                claims={pdfClaims(signature)}
                bound={pdfAttribution(signature).bound}
              />
              <Signer {...pdfAttribution(signature)} />
            </div>
          ))}
        </>
      )}

      {outcome && outcome.kind !== "error" && (
        <div class="panel">
          <h2>結果の書き出し</h2>
          <label class="check">
            <input
              type="checkbox"
              checked={includePersonalDetails}
              onChange={(e) =>
                setIncludePersonalDetails((e.target as HTMLInputElement).checked)
              }
            />
            <span>
              住所・生年月日・性別も含める
              <small>
                既定では含めません。書き出したテキストは誰でも読めます。渡す相手を決めてから入れてください。
              </small>
            </span>
          </label>
          <div class="row">
            <button class="ghost" onClick={exportResult}>
              結果をテキストで書き出す
            </button>
          </div>
          <p class="note">
            書き出すのは署名されていないただのテキストです。内容は誰でも書き換えられます。
          </p>
        </div>
      )}

      {history.length > 0 && (
        <div class="panel">
          <h2>この起動中に検証したファイル</h2>
          <ul class="files">
            {history.map((entry) => {
              const summary = historySummary(entry.outcome);
              return (
                <li key={entry.id}>
                  <code>{basename(verifiedPath(entry.outcome))}</code>
                  {/* Labelled, like every other instant on this screen: three of them are already
                      here (署名時刻・タイムスタンプ・判定基準日) and none means the same thing. */}
                  <small class="chain">検証した時刻 {entry.at}</small>
                  {summary && <strong>{summary}</strong>}
                  <button class="ghost small" onClick={() => (verifyOutcome.value = entry.outcome)}>
                    表示
                  </button>
                </li>
              );
            })}
          </ul>
          <p class="note">
            一覧に出るのは、検証できなかったものの理由だけです。うまくいった検証の要約は出しません。一行にまとめられる「有効」を、本アプリは出せないからです。中身は「表示」で確認してください。
          </p>
        </div>
      )}
    </section>
  );
}

// --- Settings -----------------------------------------------------------------------------------

export function SettingsScreen() {
  return (
    <section class="screen">
      <h1>設定</h1>
      <TsaPicker withTest />
      <div class="panel">
        <h2>検証</h2>
        <label class="check">
          <input
            type="checkbox"
            checked={acceptTestHierarchy.value}
            onChange={(e) =>
              (acceptTestHierarchy.value = (e.target as HTMLInputElement).checked)
            }
          />
          <span>
            JPKI テスト階層を受け入れる
            <small>
              テストカードの検証にのみ使います。テストカードは実在の本人のマイナンバーカードではありません。切り替えると、検証画面に表示中の結果は破棄されます（別の方針で計算した結果を残さないためです）。
            </small>
          </span>
        </label>
      </div>
      <div class="panel about-panel">
        <h2>{text("このアプリについて", "About this app")}</h2>
        <p>
          {text(
            "Myna GUI は、端末内で動作する非公式のローカル優先アプリです。J-LIS または行政機関が提供する公式アプリではありません。",
            "Myna GUI is an unofficial, local-first application. It is not provided by J-LIS or any government agency.",
          )}
        </p>
        <p class="note">
          {text(
            "テレメトリはありません。PIN と文書は端末内で処理され、タイムスタンプを有効にした場合だけ署名ハッシュが選択先へ送られます。",
            "There is no telemetry. PINs and documents are processed on this device; only a signature hash is sent when timestamping is enabled.",
          )}
        </p>
      </div>
    </section>
  );
}

const TSA_PRESET_URL: Record<"freeTsa" | "digiCert", string> = {
  freeTsa: "https://freetsa.org/tsr",
  digiCert: "http://timestamp.digicert.com",
};

/** Where the 32 bytes would go, or nothing when they go nowhere. */
function tsaDestination(config: TsaConfig): string | null {
  if (config.kind === "none") return null;
  if (config.kind === "preset") return TSA_PRESET_URL[config.preset];
  return config.url.trim() === "" ? null : config.url;
}

/**
 * Where to get a timestamp.
 *
 * The chosen endpoint is state.ts's, not this component's: the picker appears on two screens, and
 * with the URL held locally the settings copy came up empty while `tsa.value` still held an address
 * — an address the signer could then post 32 bytes to without ever having seen it.
 */
function TsaPicker({ withTest = false }: { withTest?: boolean }) {
  const [probe, setProbe] = useState<TimestampVerification | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = tsa.value;
  const emptyCustom = current.kind === "custom" && current.url.trim() === "";
  const destination = tsaDestination(current);

  useEffect(() => {
    // A probe is about the endpoint it was aimed at. Left on screen after another one is selected,
    // it reads as that one having answered.
    setProbe(null);
    setProbeError(null);
  }, [current]);

  async function test() {
    setBusy(true);
    setProbe(null);
    setProbeError(null);
    try {
      setProbe(await api.testTsa(tsa.value));
    } catch (e) {
      setProbeError(describe(asAppError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="panel">
      <h2>タイムスタンプ</h2>
      {/* A fieldset in a flex or grid context keeps its own min-content width unless told not to,
          which pushes the panel wider than the window. */}
      <fieldset style={{ minWidth: 0, border: 0, padding: 0, margin: 0 }}>
        <legend>送信先（「なし」以外を選ぶと外部サーバへ接続します）</legend>
        {(
          [
            [{ kind: "none" }, "なし（既定）"],
            [{ kind: "preset", preset: "freeTsa" }, `FreeTSA（${TSA_PRESET_URL.freeTsa}）`],
            [{ kind: "preset", preset: "digiCert" }, `DigiCert（${TSA_PRESET_URL.digiCert}）`],
          ] as [TsaConfig, string][]
        ).map(([config, label]) => (
          <label class="check" key={label}>
            <input
              type="radio"
              name="tsa"
              checked={JSON.stringify(current) === JSON.stringify(config)}
              onChange={() => (tsa.value = config)}
            />
            <span>{label}</span>
          </label>
        ))}
        <label class="check">
          <input
            type="radio"
            name="tsa"
            checked={current.kind === "custom"}
            onChange={() => (tsa.value = { kind: "custom", url: customTsaUrl.value })}
          />
          <span>任意のサーバ</span>
        </label>
      </fieldset>
      {current.kind === "custom" && (
        <label class="field">
          <span>URL</span>
          <input
            value={customTsaUrl.value}
            placeholder="https://tsa.example/tsr"
            onInput={(e) => {
              const url = (e.target as HTMLInputElement).value;
              customTsaUrl.value = url;
              // The root PEM is carried across: it belongs to the server being addressed, and
              // rebuilding the config from the URL alone dropped it on every keystroke.
              const rootPem = current.kind === "custom" ? (current.rootPem ?? null) : null;
              tsa.value = { kind: "custom", url, rootPem };
            }}
          />
        </label>
      )}
      {emptyCustom && (
        <p class="warn-box">
          <strong>送信先が未入力です。</strong>
          このままだとタイムスタンプは取得できません（署名自体は作成され、失われません）。
        </p>
      )}
      {destination === null ? (
        <p class="note">
          <strong>外部へは何も送信しません。</strong>
        </p>
      ) : (
        <p class="note">
          <strong>送信先: {destination}</strong>。送るのは署名のハッシュ 32 バイトだけで、文書は送りません。
        </p>
      )}
      {withTest && (
        <>
          <div class="row">
            <button
              class="ghost"
              onClick={test}
              disabled={busy || current.kind === "none" || emptyCustom}
            >
              接続テスト
            </button>
          </div>
          {current.kind === "none" && (
            <p class="note">
              送信先が「なし」のあいだは接続テストできません。試したい送信先を選んでください。
            </p>
          )}
          {emptyCustom && <p class="note">URL が空のあいだは接続テストできません。</p>}
          {probeError && <p class="error">{probeError}</p>}
          {probe && (
            <div class="result">
              <Claim label="応答時刻" tone="ok" state={null}>
                {formatJst(probe.genTime)}
              </Claim>
              <Claim label="ポリシー OID" tone="unknown" state={null}>
                <code>{probe.policy}</code>
              </Claim>
              <Claim label="応答者" tone="unknown" state={null}>
                {probe.chain.path[0] ?? "証明書から読み取れませんでした"}
              </Claim>
              <Claim label="ルート" tone={probe.chain.verified ? "ok" : "warn"}>
                {probe.chain.anchor ?? "未検証"}
              </Claim>
              <Claim label="トークンの検証" tone={probe.verified ? "ok" : "bad"}>
                {probe.verified ? "検証成功" : "検証失敗"}
              </Claim>
            </div>
          )}
        </>
      )}
    </div>
  );
}
