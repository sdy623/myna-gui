import { signal } from "@preact/signals";
import { options, type ComponentChild, type VNode } from "preact";

export type Locale = "ja" | "en";

// Version the override key so installs of the earlier build—which persisted its automatic guess as
// though it were a manual choice—perform one clean system-language detection after upgrading.
const STORAGE_KEY = "myna-gui.locale.override.v1";

function systemLocale(language: string): Locale {
  const primaryLanguage = language.trim().toLowerCase().split(/[-_]/, 1)[0];
  return primaryLanguage === "ja" ? "ja" : "en";
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "ja" || stored === "en") return stored;
  return systemLocale(window.navigator.language);
}

/** The UI language. Card data is never translated or sent anywhere. */
export const locale = signal<Locale>(initialLocale());

function applyDocumentLocale(next: Locale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.documentElement.dataset.locale = next;
  }
}

export function setLocale(next: Locale) {
  locale.value = next;
  applyDocumentLocale(next);
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next);
}

export function text(ja: string, en: string): string {
  return locale.value === "ja" ? ja : en;
}

/**
 * English equivalents for the existing Japanese UI.
 *
 * The upstream application was written as a Japanese-only safety tool. Keeping Japanese as the
 * canonical internal wording lets this desktop prototype stay close to upstream while the UI is
 * progressively converted to keyed messages. The VNode adapter below translates only known UI
 * phrases; reader names, paths, certificate fields, hashes and user input are left byte-for-byte
 * untouched.
 */
const EN: Record<string, string> = {
  // Shell and navigation
  "画面": "Screens",
  "カード": "Card",
  "署名": "Sign",
  "検証": "Verify",
  "設定": "Settings",
  "実行中": "Running",
  "処理中": "Processing",
  "署名中": "Signing",
  "タイムスタンプ取得中": "Requesting timestamp",
  "書き出し中": "Writing",
  "この通知を閉じる": "Dismiss this notification",
  "閉じる": "Dismiss",

  // Common actions and states
  "接続": "Connect",
  "切断": "Disconnect",
  "中止": "Stop",
  "外す": "Remove",
  "選ぶ…": "Choose…",
  "表示": "Show",
  "隠す": "Hide",
  "キャンセル": "Cancel",
  "続ける": "Continue",
  "再試行": "Try again",
  "破棄する": "Discard",
  "署名を破棄": "Discard signature",
  "やめる": "Keep it",
  "保存しました。": "Saved.",
  "署名しました。": "Signed.",
  "署名を破棄しました。": "Signature discarded.",
  "あり": "Present",
  "なし": "None",
  "未選択": "Not selected",
  "未確認": "Not checked",
  "未検証": "Not verified",
  "確認中…": "Checking…",
  "問題なし": "No issues found",
  "要注意": "Needs attention",
  "問題あり": "Problem found",
  "適用不能": "Not applicable",
  "ロック": "Locked",
  "ロック済み": "Locked",

  // Card screen
  "リーダーを探す": "Find readers",
  "これに接続": "Connect to this reader",
  "リーダー": "Reader",
  "読み取った媒体": "Detected credential",
  "署名用電子証明書": "Signing certificate",
  "利用者証明用電子証明書（パスワード不要）": "User-authentication certificate (no password required)",
  "署名用パスワード": "Signing password",
  "カードを読み取りました。": "Card read successfully.",
  "カードリーダーが 1 台も見つかりませんでした。": "No smart-card readers were found.",
  "接続時に読み出すのは利用者証明用電子証明書だけです。署名用電子証明書（氏名・住所・生年月日・性別）は、署名するときにパスワードを入力するまで読み出しません。":
    "On connection, only the user-authentication certificate is read. The signing certificate (name, address, date of birth and sex) is not read until you enter the signing password.",
  "接続している間、本アプリはカードを占有します。切断するまで、e-Tax や JPKI 利用者ソフトなどからはこのカードを使えません。ほかのアプリが先に使っているときは接続できません。":
    "While connected, this app has exclusive use of the card. e-Tax, JPKI User Software and other apps cannot use it until you disconnect. Connection also fails while another app is using the card.",
  "このカードには署名用電子証明書がありません（15 歳未満などでは発行されません）。このカードでは署名できません。":
    "This card has no signing certificate (one may not be issued, for example, to holders under 15). It cannot be used to sign.",
  "この証明書には基本4情報が含まれます。.asc では埋め込むかどうかを選べます。PDF では必ず埋め込まれます。埋め込んだファイルを渡すことは、これらの情報を渡すことです。":
    "This certificate contains the four basic identity attributes. Embedding it is optional for .asc signatures and mandatory for PDFs. Sharing the signed file also shares those attributes.",
  "（マイナンバーカード）": " (Individual Number Card)",
  "（スマホ用電子証明書）": " (mobile certificate)",
  "残り回数を確認できませんでした": "Remaining attempts could not be checked",
  "すでに何回間違えているか分かりません。続けて間違えるとロックされます。":
    "The number of previous failures is unknown. Another incorrect entry may lock the card.",
  "ロック済み。市区町村の窓口でのみ解除できます。":
    "Locked. It can only be unlocked at a municipal service counter.",
  "カードを切断し、セキュリティ状態をリセットしました。パスワードは本アプリに残っておらず、次に署名するときはもう一度入力が必要です。":
    "Disconnected and reset the card security state. The password is not retained; you must enter it again next time you sign.",

  // Certificate fields
  "主体者": "Subject",
  "氏名": "Name",
  "住所": "Address",
  "生年月日": "Date of birth",
  "性別": "Sex",
  "男性": "Male",
  "女性": "Female",
  "発行者": "Issuer",
  "有効期間": "Validity",
  "鍵長": "Key size",
  "フィンガープリント": "Fingerprint",
  "個人情報": "Personal information",

  // Signing screen
  "カードが接続されていません。": "No card is connected.",
  "署名するにはカードの接続が必要です。": "Connect a card before signing.",
  "カード画面を開く": "Open Card screen",
  "ファイルを選ぶ": "Choose files",
  "署名する": "Sign",
  "署名するファイル": "Files to sign",
  "署名するファイルが選ばれていません。": "No files have been selected for signing.",
  "「ファイルを選ぶ」を押すか、この画面にファイルをドロップしてください。PDF を 1 つだけ選ぶと、その中に署名を埋め込みます。":
    "Choose files or drop them onto this screen. Selecting a single PDF embeds the signature in that PDF.",
  "さらに追加": "Add more",
  "このほかに作成されるファイル": "Additional output files",
  "既存のファイルを上書きします": "Will overwrite an existing file",
  "OpenPGP 署名（.asc）": "OpenPGP signature (.asc)",
  "OpenPGP 公開鍵": "OpenPGP public key",
  "OpenPGP 公開鍵（.pubkey.asc）": "OpenPGP public key (.pubkey.asc)",
  "タイムスタンプトークン（.tsr）": "Timestamp token (.tsr)",
  "署名用電子証明書を埋め込む": "Embed the signing certificate",
  "氏名・住所・生年月日・性別が開示されます": "This discloses the holder's name, address, date of birth and sex",
  "OpenPGP 公開鍵も書き出す": "Also export the OpenPGP public key",
  "クリアテキスト署名にする": "Create a cleartext signature",
  "タイムスタンプトークンを .tsr としても書き出す": "Also export the timestamp token as .tsr",
  "PDF 署名": "PDF signature",
  "理由": "Reason",
  "場所": "Location",
  "署名をページに表示しない": "Do not show the signature on the page",
  "自分の画像を使う": "Use a custom image",
  "署名できなかったファイルがあります": "Some files could not be signed",
  "カードに送っていないファイル:": "Files not sent to the card:",
  "再実行には署名用パスワードの再入力が必要です。": "Trying again requires the signing password.",
  "タイムスタンプを取得できませんでした": "Could not obtain a timestamp",
  "署名を書き出せませんでした": "Could not write the signature",
  "タイムスタンプの取得を中止しました": "Timestamp request stopped",
  "署名そのものは作成済みです。": "The signature itself has already been created.",
  "タイムスタンプなしで保存": "Save without timestamp",
  "別の場所に保存…": "Save somewhere else…",
  "出力": "Output",
  "パスをコピー": "Copy path",
  "パスをコピーしました。": "Path copied.",
  "保存先の指定をやめました。署名はそのまま残っています。":
    "Destination selection was cancelled. The signature is still retained.",
  "まだ書き出せていない署名があります。": "Some signatures have not yet been written.",
  "署名の位置はまだ指定されていません。": "The signature position has not been set.",
  "一部のファイルを署名できませんでした。": "Some files could not be signed.",

  // Timestamp settings
  "タイムスタンプ": "Timestamp",
  "送信先（「なし」以外を選ぶと外部サーバへ接続します）":
    "Destination (choosing anything other than None connects to an external server)",
  "なし（既定）": "None (default)",
  "任意のサーバ": "Custom server",
  "送信先が未入力です。": "No destination has been entered.",
  "このままだとタイムスタンプは取得できません（署名自体は作成され、失われません）。":
    "A timestamp cannot be obtained until a destination is entered. The signature itself will still be created and retained.",
  "外部へは何も送信しません。": "Nothing is sent outside this device.",
  "接続テスト": "Test connection",
  "送信先が「なし」のあいだは接続テストできません。試したい送信先を選んでください。":
    "Select a timestamp service before testing the connection.",
  "URL が空のあいだは接続テストできません。": "Enter a URL before testing the connection.",
  "応答時刻": "Response time",
  "ポリシー OID": "Policy OID",
  "応答者": "Responder",
  "ルート": "Root",
  "トークンの検証": "Token verification",
  "証明書から読み取れませんでした": "Could not read from the certificate",
  "検証成功": "Verified",
  "検証失敗": "Verification failed",

  // Verification screen
  "JPKI テスト階層を受け入れる設定が ON です。": "JPKI test hierarchy acceptance is ON.",
  "テストカードの署名も「ルートまで到達」と表示されます。": "Signatures from test cards will also be shown as reaching a root.",
  "テストカードは実在の本人のマイナンバーカードではありません。": "A test card is not a real person's Individual Number Card.",
  "OFF に戻す": "Turn OFF",
  "検証するファイル": "Files to verify",
  "署名ファイル": "Signature file",
  ".asc / .sig、または署名済み PDF": ".asc / .sig, or a signed PDF",
  "原本": "Original file",
  "分離署名（.asc / .sig）が署名したファイルそのもの":
    "The original file covered by the detached .asc / .sig signature",
  "署名ファイル（.asc / .sig）または署名済み PDF を選んでください。":
    "Choose a signature file (.asc / .sig) or a signed PDF.",
  "検証する": "Verify",
  "この画面で分かること": "What this screen can establish",
  "その署名が、表示している証明書の鍵で作られたものかどうか":
    "Whether the signature was made with the key in the displayed certificate",
  "署名の対象になったファイルが、署名の後で変わっていないかどうか":
    "Whether the signed file has changed since it was signed",
  "証明書が J-LIS のルートまでつながるかどうか": "Whether the certificate chains to a J-LIS root",
  "タイムスタンプがあるかどうか、あるならその時刻": "Whether a timestamp exists and, if so, its time",
  "この画面で分からないこと": "What this screen cannot establish",
  "証明書が失効していないかどうかは確認しません。本アプリは JPKI 失効情報サービスを参照しないため、失効した証明書による署名でも、この画面の表示は変わりません。":
    "Certificate revocation is not checked. Because this app does not access the JPKI revocation service, this screen will look the same even when a certificate has been revoked.",
  "検証にカード・パスワード・通信は必要ありません。": "Verification requires no card, password or network connection.",
  "検証できませんでした": "Could not verify",
  "検証対象": "Verification target",
  "OpenPGP 署名の検証": "OpenPGP signature verification",
  "検証対象（署名）": "Verification target (signature)",
  "検証対象（原本）": "Verification target (original)",
  "PDF 署名の検証": "PDF signature verification",
  "署名フィールドが 1 つも見つかりませんでした": "No signature fields were found",
  "結果の書き出し": "Export results",
  "住所・生年月日・性別も含める": "Also include address, date of birth and sex",
  "結果をテキストで書き出す": "Export results as text",
  "この起動中に検証したファイル": "Files verified during this session",
  "検証した時刻": "Verified at",
  "確認できたこと": "Confirmed",
  "注意が必要なこと": "Needs attention",
  "この検証で確認していないこと": "Not checked by this verification",
  "署名の検証": "Signature verification",
  "文書の同一性": "Document integrity",
  "署名範囲": "Signed scope",
  "署名後の追記": "Changes after signing",
  "証明書チェーン": "Certificate chain",
  "失効確認": "Revocation status",
  "判定基準日": "Evaluation date",
  "現在時刻": "Current time",
  "署名時刻（自己申告）": "Signing time (self-reported)",
  "場所（自己申告）": "Location (self-reported)",
  "理由（自己申告）": "Reason (self-reported)",
  "署名欄の名前（自己申告）": "Signature-field name (self-reported)",
  "署名者": "Signer",
  "応答者とルート": "Responder and root",
  "ルートまで到達": "Chains to a root",
  "J-LIS ルートまで到達": "Chains to a J-LIS root",
  "J-LIS ルートまで到達（テスト階層）": "Chains to a J-LIS root (test hierarchy)",
  "ルートに到達しません": "Does not chain to a root",
  "失効確認 — 未実施": "Revocation status — not checked",
  "未実施（本アプリは JPKI 失効情報サービスを参照しません）":
    "Not checked (this app does not access the JPKI revocation service)",
  "証明書が失効していても、この結果は変わりません。":
    "This result does not change even if the certificate has been revoked.",
  "署名が一致しません": "Signature does not match",
  "署名が見つかりません": "No signature found",
  "署名対象と一致しません": "Does not match the signed content",
  "この署名は検証できませんでした": "This signature could not be verified",
  "この証明書の鍵で作られた署名です": "The signature was made with this certificate's key",
  "この文書と署名は一致しません": "This document does not match the signature",
  "署名時から変更されていません": "Unchanged since signing",
  "署名欄以外のすべてを署名しています": "Everything except the signature field is signed",
  "署名されていない領域があります（内容が隠されている可能性）":
    "Some areas are unsigned (content may be hidden there)",
  "証明書がないため未検証": "Not verified because no certificate is attached",
  "証明書は埋め込みません": "Certificate will not be embedded",
  "用途が違います": "Wrong key usage",
  "これらは署名と証明書についての事実で、この文書については何も示していません":
    "These are facts about the signature and certificate; they say nothing about this document.",
  "本アプリは失効情報サービスを参照しません。証明書が失効していても、この画面の表示は変わりません。":
    "This app does not access a revocation service. This screen will not change even if the certificate has been revoked.",
  "この証明書の名義人がこの文書に署名したことを確認できないため、氏名は表示しません":
    "The name is hidden because this verification cannot establish that the certificate holder signed this document.",
  "証明書の有効期間": "Certificate validity",
  "この署名を対象としていません": "Does not cover this signature",
  "トークンの署名が検証できません": "The token signature could not be verified",
  "応答者証明書に timeStamping の拡張鍵用途がありません":
    "The responder certificate lacks the timeStamping extended key usage",
  "証明書の有効期限が切れると、署名時点で有効だったことを示せなくなります。":
    "Once the certificate expires, this cannot establish that it was valid when the signature was made.",
  "テスト階層 — 実在の本人ではありません。": "Test hierarchy — this is not a real person.",
  "証明書が期限切れになると検証できなくなります。":
    "Verification may no longer be possible after the certificate expires.",
  "署名した側の端末が申告した時刻で、検証されていません。":
    "This time was reported by the signer's device and has not been verified.",
  "原本が署名の後で変わったか、この証明書の鍵で作られた署名ではないかのどちらかです。":
    "Either the original changed after signing, or the signature was not made with this certificate's key.",
  "この文書に対し、署名に含まれる鍵で作られた署名です":
    "This document was signed with the key included in the signature",
  "証明書が添付されていないため、その鍵が誰のものかは分かりません。":
    "No certificate is attached, so the owner of that key cannot be established.",
  "署名を作った鍵が、添付されている証明書の鍵と一致しません":
    "The signing key does not match the key in the attached certificate",
  "他人の証明書が貼り付けられている可能性があります。":
    "A different person's certificate may have been attached.",
  "この文書に対し、この証明書の鍵で作られた署名です":
    "This document was signed with this certificate's key",
  "この証明書の鍵で作られた署名として検証できません":
    "Could not verify this as a signature made with this certificate's key",
  "署名者の証明書を取り出せませんでした": "The signer's certificate could not be extracted",
  "この証明書の鍵で作られた署名ですが、証明書を指定する情報（signingCertificate 属性）を確認できません":
    "The signature was made with this certificate's key, but the signingCertificate attribute could not be confirmed",
  "署名が本当にこの証明書に向けて作られたのかを、署名の中の情報で裏づけられません。":
    "The signature data does not establish that the signature was specifically made for this certificate.",
  "文書が署名時のままかどうかは「文書の同一性」が示します。":
    "Document integrity shows whether the document is unchanged since signing.",
  "この署名が対象とした内容と、いま開いているファイルが違います。":
    "The open file differs from the content covered by this signature.",
  "後から署名が足された場合もこうなります。追記の中身はこの署名の対象ではありません。":
    "This also occurs when another signature is added later. The appended content is not covered by this signature.",
  "署名者が書き込んだ文字列で、証明書とは照合していません。":
    "This text was entered by the signer and was not compared with the certificate.",
  "証明書が添付されていないため分かりません":
    "Unknown because no certificate is attached",
  "この署名と証明書の結び付きが確認できないため、氏名は出力しません":
    "The name is omitted because the link between this signature and certificate could not be confirmed",
  "住所・生年月日・性別: 出力時に省略（証明書には含まれています）":
    "Address, date of birth and sex: omitted from this export (present in the certificate)",
  "その他の記載事項（OID 表示）: 出力時に省略（証明書には含まれています）":
    "Other attributes (shown as OIDs): omitted from this export (present in the certificate)",

  // Settings
  "JPKI テスト階層を受け入れる": "Accept the JPKI test hierarchy",
  "テストカードの検証にのみ使います。テストカードは実在の本人のマイナンバーカードではありません。切り替えると、検証画面に表示中の結果は破棄されます（別の方針で計算した結果を残さないためです）。":
    "Use this only to verify test cards. A test card is not a real person's Individual Number Card. Changing this option clears the result currently shown on the Verify screen so results calculated under a different policy are not retained.",

  // Password dialog
  "署名用パスワードを入力": "Enter signing password",
  "以下に電子署名します。": "You are about to electronically sign:",
  "外部通信": "External communication",
  "パスワードを表示": "Show password",
  "パスワードを隠す": "Hide password",
  "署名用パスワードは 6〜16 文字です。": "The signing password must be 6–16 characters.",
  "使えるのは英数字（A〜Z と 0〜9）だけです。": "Use only uppercase letters A–Z and digits 0–9.",
  "英字は大文字で入力してください。署名用パスワードは大文字で登録されています。":
    "Enter letters in uppercase; the signing password is registered in uppercase.",
  "次に間違えるとロックされます。本当に送信しますか？":
    "One more incorrect attempt will lock the card. Send the password anyway?",
  "何回間違えているか分からないため、次でロックされるかもしれません。本当に送信しますか？":
    "The remaining attempts are unknown and the next error may lock the card. Send the password anyway?",
  "ロック済み — 市区町村の窓口でのみ解除できます":
    "Locked — it can only be unlocked at a municipal service counter",
  "カードは残り回数を報告していません。": "The card did not report the remaining attempts.",
  "外部へは何も送信しません": "Nothing is sent outside this device",
  "ページ上の署名欄": "Visible signature field",
  "署名ファイル（.asc）": "Signature file (.asc)",
  "公開鍵ファイル": "Public-key file",
  "この PDF には署名用電子証明書が必ず入ります —":
    "The signing certificate is always embedded in this PDF —",
  "が相手に開示されます（外せません）。": "will be disclosed to the recipient and cannot be removed.",
  "さらに、ページ上の署名欄に": "The visible signature field will also show",
  "氏名と住所": "name and address",
  "が印字されます。証明書の表記には": ". Certificate text may contain",
  "戸籍と異なる代替文字が使われていることがあります。":
    "substitute characters that differ from the family-register spelling.",
  ".asc に署名用電子証明書を埋め込みます —":
    "The signing certificate will be embedded in the .asc file —",
  "が相手に開示されます。": "will be disclosed to the recipient.",
  "証明書は埋め込みません。相手は別途あなたの証明書を受け取らないと検証できません。":
    "The certificate will not be embedded. The recipient must obtain your certificate separately to verify the signature.",
  "併せて書き出す": "The exported",
  "の User ID に氏名が入ります。": "contains the holder's name in its User ID.",
  "併せて書き出す公開鍵ファイルの User ID に氏名が入ります。":
    "The exported public-key file contains the holder's name in its User ID.",
  "送信先:": "Destination:",
  "。送るのは署名のハッシュ 32": ". Only the 32-byte signature hash is sent;",
  "バイトだけで、文書は送りません。": "the document is never sent.",
  "英数字 6〜16 文字（": "6–16 uppercase letters or digits (",
  "英字は大文字": "letters must be uppercase",
  "）": ")",

  // PDF placement
  "ページ": "Page",
  "縮小": "Zoom out",
  "拡大": "Zoom in",
  "ページ全体に合わせる": "Fit page",
  "既定の位置": "Default position",
  "既定の位置に戻す": "Reset to default position",
  "既定の位置です。": "This is the default position.",
  "読み込み中…": "Loading…",
  "ページに描く画像を選ぶ": "Choose an image to place on the page",
  "プレビューを表示できません。": "Could not display the preview.",
  "既定の署名位置を取得できませんでした。ドラッグで指定してください。":
    "The default signature position could not be obtained. Drag to choose a position.",
  "この位置に署名されます。変えたいときは、どのページでもドラッグしてください。":
    "The signature will be placed here. Drag on any page to choose another position.",
  "どのページでもドラッグすると、そのページに署名が置かれます。":
    "Drag on any page to place the signature there.",
};

type Pattern = readonly [RegExp, (...groups: string[]) => string];

const EN_PATTERNS: readonly Pattern[] = [
  [/^残り (\d+) 回。?$/, (count) => `${count} attempts remaining.`],
  [/^あと (\d+) 回続けて間違えるとロックされ、市区町村の窓口でしか解除できません。$/, (count) =>
    `The card will lock after ${count} more consecutive incorrect attempts and can then only be unlocked at a municipal service counter.`],
  [/^(\d+) 件を書き出し$/, (count) => `${count} written`],
  [/^(\d+) 件はタイムスタンプ待ち$/, (count) => `${count} awaiting timestamps`],
  [/^(\d+) 件は書き出し待ち$/, (count) => `${count} awaiting output`],
  [/^(\d+) 件は取得を中止$/, (count) => `${count} timestamp requests stopped`],
  [/^(\d+) 件は未署名$/, (count) => `${count} unsigned`],
  [/^(\d+) 件は破棄$/, (count) => `${count} discarded`],
  [/^(\d+) 件は結果が分かりません$/, (count) => `${count} with unknown outcome`],
  [/^署名 (\d+)$/, (number) => `Signature ${number}`],
  [/^(\d+) ページ目$/, (number) => `Page ${number}`],
  [/^(\d+) ページ目のプレビュー。内容は読み上げられません。$/, (number) =>
    `Preview of page ${number}. Page contents cannot be read aloud.`],
  [/^(\d+) ページ目。左下から右へ (\d+)pt、上へ (\d+)pt、幅 (\d+)pt、高さ (\d+)pt。(.*)$/,
    (page, x, y, width, height, suffix) =>
      `Page ${page}. ${x} pt from the left, ${y} pt from the bottom; width ${width} pt, height ${height} pt.${suffix ? ` ${translateCore(suffix, "en")}` : ""}`],
  [/^幅 (\d+)pt、高さ (\d+)pt。$/, (width, height) => `Width ${width} pt, height ${height} pt.`],
  [/^送信先: (.+)。送るのは署名のハッシュ 32 バイトだけで、文書は送りません。$/, (destination) =>
    `Destination: ${destination}. Only the 32-byte signature hash is sent; the document is never sent.`],
  [/^検証した時刻 (.+)$/, (instant) => `Verified at ${instant}`],
  [/^ルート: (.+)$/, (anchor) => `Root: ${anchor}`],
  [/^(.+) の署名$/, (name) => `Signature for ${name}`],
  [/^(.+) の署名に失敗したため、そこで中断しました。$/, (path) =>
    `Signing ${path} failed, so processing stopped there.`],
  [/^この署名の後に (\d+) バイトが追記されています$/, (count) =>
    `${count} bytes were appended after this signature`],
  [/^(\d+) 件の署名に問題があります$/, (count) => `${count} signatures have problems`],
];

function translateCore(core: string, target: Locale): string {
  if (target === "ja" || !/[ぁ-んァ-ヶ一-龠（）]/.test(core)) return core;
  const normalized = core.replace(/\s+/g, " ").trim();
  const exact = EN[normalized];
  if (exact !== undefined) return exact;
  for (const [pattern, replacement] of EN_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return replacement(...match.slice(1));
  }
  return core.replaceAll("（", " (").replaceAll("）", ")");
}

export function translateUiString(value: string, target: Locale = locale.value): string {
  if (target === "ja" || !/[ぁ-んァ-ヶ一-龠（）]/.test(value)) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);
  return `${leading}${translateCore(core, target)}${trailing}`;
}

/** Translate report labels and findings while preserving paths and certificate data verbatim. */
export function translateReportLine(value: string, target: Locale = locale.value): string {
  if (target === "ja" || value === "") return value;
  const claim = value.match(/^(\s*)\[([^\]]+)\] ([^:]+): (.*)$/);
  if (claim) {
    const [, indent, tone, label, finding] = claim;
    return `${indent}[${translateCore(tone, target)}] ${translateCore(label, target)}: ${translateCore(finding, target)}`;
  }
  const field = value.match(/^(\s*)(検証対象（署名）|検証対象（原本）|検証対象|住所|生年月日|性別|発行者|証明書の有効期間|フィンガープリント): (.*)$/);
  if (field) {
    const [, indent, label, data] = field;
    return `${indent}${translateCore(label, target)}: ${data}`;
  }
  return translateUiString(value, target);
}

function translateChild(child: ComponentChild): ComponentChild {
  if (typeof child === "string") return translateUiString(child);
  if (Array.isArray(child)) return child.map(translateChild);
  return child;
}

let installed = false;

/** Install a render-time adapter for the upstream Japanese JSX. */
export function installI18n() {
  if (installed) return;
  installed = true;
  // Apply the automatic language without turning it into a persisted manual override.
  applyDocumentLocale(locale.peek());

  const previous = options.vnode;
  options.vnode = (vnode: VNode) => {
    const props = vnode.props as Record<string, unknown> | null;
    if (props && typeof props === "object") {
      const tag = typeof vnode.type === "string" ? vnode.type : null;
      if (tag !== "code" && tag !== "pre" && "children" in props) {
        props.children = translateChild(props.children as ComponentChild);
      }
      for (const name of ["aria-label", "title", "placeholder", "alt", "label", "heading"] as const) {
        if (typeof props[name] === "string") props[name] = translateUiString(props[name]);
      }
    }
    previous?.(vnode);
  };
}
