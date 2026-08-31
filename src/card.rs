//! The card side of myna-sign.
//!
//! Everything that touches a reader lives here, and nothing else does. The signing-format modules
//! know only [`crate::DigestSigner`]; [`CardSigner`] is the implementation that involves hardware,
//! alongside the session handling for a card whose state outlives the process.
//!
//! # The security status outlives your program
//!
//! `myna-card` says it plainly and it bears repeating, because it decides the shape of this
//! module: a successful VERIFY survives dropping and reopening the connection. It is cleared when
//! the card leaves the field or when a different application is selected. A fresh process is not
//! by itself a fresh card.
//!
//! So [`CardSession`] selects the master-file state when it is finished with, in
//! [`CardSession::close`] and again in `Drop` for the paths that do not get there. On the Individual
//! Number Card that means selecting the GlobalPlatform Issuer Security Domain; leaving the JPKI
//! application clears its security status without interrupting power. Without that, closing the
//! application leaves the signature key unlocked for whatever talks to the card next.
//!
//! Selecting the master-file state closes the window at the end. [`Sharing::Exclusive`] closes it
//! in the middle: a shared connection leaves the unlocked key reachable by anything else on the
//! machine for as long as the session lasts, and that is the whole time between the password and
//! the signature. A session that will present a password takes the card to itself; one that only
//! reads does not, because reserving a card nobody is signing with locks out software somebody may
//! be relying on.
//!
//! # Retry counters
//!
//! The signature password allows five attempts, and a blocked key can only be unblocked at a
//! municipal office. [`CardSession::sign_pin_retries`] asks the card how many are left without
//! spending one, and [`CardSession::unlock`] refuses to present a password to a key that is
//! already blocked rather than confirming the bad news at the user's expense.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use myna_card::ap::jpki::{JpkiAp, SignatureScheme, TokenType};
use myna_card::ap::surface::{self, SurfaceAp};
use myna_card::ap::text::{self, TextAp};
use myna_card::transport::pcsc::{self, PcscTransport};
// The PC/SC crate itself, aliased so `pcsc` keeps meaning myna-card's module everywhere below.
use crate::error::{Error, Result};
use crate::signer::DigestSigner;
use crate::x509::CertificateInfo;
use ::pcsc as pcsc_crate;
use myna_card::{Card, Certificate, MasterFile, Pin, Retries};
use serde::Serialize;
use zeroize::Zeroize;

pub use myna_card::transport::pcsc::Sharing;

/// The readers the PC/SC service knows about.
pub fn list_readers() -> Result<Vec<String>> {
    Ok(pcsc::list_readers()?)
}

/// Whether this error is another program holding the card.
///
/// Worth telling apart from every other PC/SC failure because it is the one the person at the
/// keyboard can act on — close the other software, try again — and because it is the expected
/// answer rather than a fault: asking for the card to yourself is asking something that can
/// reasonably be refused.
///
/// A predicate rather than an error variant of its own so that the `pcsc` crate stays inside this
/// module. Callers match on the answer, not on a message.
pub fn is_card_busy(error: &Error) -> bool {
    matches!(
        error,
        Error::Card(myna_card::Error::Pcsc(pcsc_crate::Error::SharingViolation))
    )
}

/// What the card says about itself before anything is presented to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardStatus {
    /// The reader it is in.
    pub reader: String,
    /// `JPKIAPICCTOKEN2` for a plastic card, or one of the phone tokens.
    pub token_type: String,
    /// Whether this is the card rather than the スマホ用電子証明書.
    pub physical_card: bool,
    /// Whether a 署名用証明書 is present.
    ///
    /// It is optional — it is not issued to children under fifteen — so an application that is
    /// about to ask for a signature password can find out first whether there is anything to sign
    /// with.
    pub has_sign_certificate: bool,
    /// Whether a 利用者証明用証明書 is present.
    pub has_auth_certificate: bool,
    /// Attempts left on the signature password, or `None` if the card would not say.
    pub sign_pin_retries: Option<u8>,
    /// Attempts left on the authentication PIN.
    pub auth_pin_retries: Option<u8>,
}

/// The seven retry counters shown by `myna pin status`.
///
/// Reading a counter does not spend an attempt. `None` means the card did not report a finite
/// count; zero means the credential is blocked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinStatuses {
    /// 券面入力補助AP four-digit PIN.
    pub card_pin: Option<u8>,
    /// 券面入力補助AP 照合番号A.
    pub text_code_a: Option<u8>,
    /// 券面入力補助AP 照合番号B.
    pub text_code_b: Option<u8>,
    /// 券面事項確認AP 照合番号A.
    pub surface_code_a: Option<u8>,
    /// 券面事項確認AP 照合番号B.
    pub surface_code_b: Option<u8>,
    /// JPKI user-authentication PIN.
    pub auth_pin: Option<u8>,
    /// JPKI digital-signature password.
    pub sign_pin: Option<u8>,
}

/// An encoded image read from the card.
///
/// Bytes are base64 because Tauri's JSON IPC otherwise expands every byte into a JSON number.
/// The browser builds a local `data:` URL from this value; nothing is uploaded.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardImage {
    /// MIME type of the encoded bytes.
    pub mime_type: &'static str,
    /// Conventional filename extension without a dot.
    pub extension: &'static str,
    /// Encoded bytes.
    pub base64: String,
}

impl CardImage {
    fn png(data: &[u8]) -> Self {
        Self {
            mime_type: "image/png",
            extension: "png",
            base64: BASE64.encode(data),
        }
    }

    fn jpeg2000(data: &[u8]) -> Self {
        Self {
            mime_type: "image/jp2",
            extension: "jp2",
            base64: BASE64.encode(data),
        }
    }
}

/// Text and rendered card-face information, read with the four-digit card PIN.
///
/// The 個人番号 is used inside the operation as 照合番号A, but is deliberately absent here: this
/// operation needs it as a key, not as output.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardIdentity {
    /// Name from 券面入力補助AP.
    pub name: String,
    /// Address from 券面入力補助AP.
    pub address: String,
    /// Gregorian date of birth.
    pub birth_date: String,
    /// JIS X 0303 sex code (`0`, `1`, `2`, `9`, or the card's other byte).
    pub sex: String,
    /// Card expiry printed in the 券面 record.
    pub expiry: String,
    /// Name as rendered on the card.
    pub name_image: CardImage,
    /// Address as rendered on the card.
    pub address_image: CardImage,
    /// Browser-compatible PNG preview of the JPEG 2000 photograph.
    pub photo_preview: CardImage,
    /// Photograph exactly as stored on the card, for `.jp2` export.
    pub photo_original: CardImage,
    /// The signed text integrity record, card-face record and their CVCs all verified.
    pub data_verified: bool,
    /// A fresh challenge was signed by the card-face private key and verified.
    pub card_present_verified: bool,
    /// The expiry field is outside the signed portion of the card-face record.
    pub expiry_covered_by_signature: bool,
}

/// The protected signing certificate and its issuing CA, read without leaving the key unlocked.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignCertificates {
    /// The holder's signing certificate. This carries the basic four attributes.
    pub certificate: CertificateInfo,
    /// The CA certificate above it, if the card returned it.
    pub ca_certificate: Option<CertificateInfo>,
}

/// Which credential to replace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// 券面入力補助AP four-digit PIN.
    Card,
    /// JPKI user-authentication four-digit PIN.
    Auth,
    /// JPKI digital-signature password.
    Sign,
}

/// A connection to a card.
#[derive(Debug)]
pub struct CardSession {
    card: Card<PcscTransport>,
    reader: String,
    sign_certificate: Option<Certificate>,
    sign_ca_certificate: Option<Certificate>,
    closed: bool,
}

impl CardSession {
    /// Connect to a card.
    ///
    /// `reader` names one, or the first available is used. `sharing` says whether anything else may
    /// hold the card meanwhile: [`Sharing::Exclusive`] for a session that will present the
    /// signature password, [`Sharing::Shared`] for one that only reads.
    ///
    /// # Errors
    ///
    /// [`is_card_busy`] is true of the error when `sharing` is [`Sharing::Exclusive`] and something
    /// else already has the card.
    pub fn connect(reader: Option<&str>, sharing: Sharing) -> Result<Self> {
        let (card, reader) = match reader {
            Some(name) => (pcsc::connect(name, sharing)?, name.to_owned()),
            None => {
                let name = pcsc::list_readers()?
                    .into_iter()
                    .next()
                    .ok_or(myna_card::Error::NoReader)?;
                (pcsc::connect(&name, sharing)?, name)
            }
        };
        Ok(CardSession {
            card,
            reader,
            sign_certificate: None,
            sign_ca_certificate: None,
            closed: false,
        })
    }

    /// The reader this session is on.
    pub fn reader(&self) -> &str {
        &self.reader
    }

    /// Read what the card will say without a password.
    pub fn status(&mut self) -> Result<CardStatus> {
        let mut jpki = JpkiAp::select(&mut self.card)?;
        let token_type = jpki.read_token_type()?;
        let availability = jpki.read_certificate_availability()?;
        // Asking for the counters costs nothing: JICSAP 6.4.9 (5) defines an empty VERIFY as
        // reporting the remaining attempts without consuming one.
        let sign_pin_retries = jpki.sign_pin_retries().ok().and_then(Retries::count);
        let auth_pin_retries = jpki.auth_pin_retries().ok().and_then(Retries::count);

        Ok(CardStatus {
            reader: self.reader.clone(),
            token_type: token_type.name().to_owned(),
            physical_card: matches!(token_type, TokenType::Card),
            has_sign_certificate: availability.has_sign_certificate(),
            has_auth_certificate: availability.has_auth_certificate(),
            sign_pin_retries,
            auth_pin_retries,
        })
    }

    /// The 利用者証明用証明書, which needs no password.
    ///
    /// Useful for showing that a card is present and readable before asking for anything. It
    /// carries no 基本4情報 — that is the other certificate.
    pub fn auth_certificate(&mut self) -> Result<CertificateInfo> {
        let mut jpki = JpkiAp::select(&mut self.card)?;
        CertificateInfo::read(&jpki.read_auth_certificate()?)
    }

    /// The CA certificate above the 利用者証明用証明書.
    pub fn auth_ca_certificate(&mut self) -> Result<CertificateInfo> {
        let mut jpki = JpkiAp::select(&mut self.card)?;
        CertificateInfo::read(&jpki.read_auth_ca_certificate()?)
    }

    /// The CA certificate above the 署名用証明書, once the signing password was presented.
    pub fn sign_ca_certificate(&self) -> Result<Option<CertificateInfo>> {
        self.sign_ca_certificate
            .as_ref()
            .map(CertificateInfo::read)
            .transpose()
    }

    /// Read the same seven remaining-attempt counters as `myna pin status`.
    ///
    /// No credential is presented. Selecting the non-JPKI applications clears any earlier JPKI
    /// VERIFY, so the cached signer is invalidated and the card is returned to its master-file
    /// state before this method returns.
    pub fn pin_statuses(&mut self) -> Result<PinStatuses> {
        self.invalidate_jpki_cache();
        let result = (|| {
            let (auth_pin, sign_pin) = {
                let mut jpki = JpkiAp::select(&mut self.card)?;
                (
                    jpki.auth_pin_retries()?.count(),
                    jpki.sign_pin_retries()?.count(),
                )
            };
            let (card_pin, text_code_a, text_code_b) = {
                let mut text_ap = TextAp::select(&mut self.card)?;
                (
                    text_ap.retries(text::ef::PIN)?.count(),
                    text_ap.retries(text::ef::CODE_A)?.count(),
                    text_ap.retries(text::ef::CODE_B)?.count(),
                )
            };
            let (surface_code_a, surface_code_b) = {
                let mut surface_ap = SurfaceAp::select(&mut self.card)?;
                (
                    surface_ap.retries(surface::ef::CODE_A)?.count(),
                    surface_ap.retries(surface::ef::CODE_B)?.count(),
                )
            };
            Ok(PinStatuses {
                card_pin,
                text_code_a,
                text_code_b,
                surface_code_a,
                surface_code_b,
                auth_pin,
                sign_pin,
            })
        })();
        finish_with_reset(result, self.reset_security_status())
    }

    /// Read text attributes, rendered card-face fields and the photograph.
    ///
    /// The supplied value is the four-digit 券面入力補助AP PIN. It first opens the text
    /// application, where the 個人番号 is read only long enough to derive 照合番号A for the
    /// card-face application. The number is never returned or logged. Both records and their
    /// card-verifiable certificates are checked, and a fresh challenge proves the matching card is
    /// still present. All application security states are reset before returning.
    pub fn read_identity(&mut self, password: &mut String) -> Result<CardIdentity> {
        let pin_result = four_digit_pin(password.as_bytes());
        password.zeroize();
        let pin = pin_result?;

        self.invalidate_jpki_cache();
        let result = (|| {
            let (code_a, attributes) = {
                let mut text_ap = TextAp::select(&mut self.card)?;
                ensure_not_blocked(text_ap.retries(text::ef::PIN)?)?;
                text_ap.verify_pin(&pin)?;

                let certificate = text_ap.read_certificate()?;
                certificate.verify()?;
                let my_number = text_ap.read_my_number()?;
                let attributes = text_ap.read_attributes()?;
                let integrity = text_ap.read_integrity_record()?;
                let my_number_file = text_ap.read_my_number_file()?;
                let attributes_file = text_ap.read_ef(text::ef::ATTRIBUTES)?;
                integrity.verify(&certificate.public_key)?;
                if !integrity.matches_my_number_file(&my_number_file)
                    || !integrity.matches_attributes_file(&attributes_file)?
                {
                    return Err(Error::SignatureInvalid(
                        "the card-face input helper integrity record does not match its files"
                            .into(),
                    ));
                }
                (my_number.as_verification_code_a()?, attributes)
            };

            let mut surface_ap = SurfaceAp::select(&mut self.card)?;
            ensure_not_blocked(surface_ap.retries(surface::ef::CODE_A)?)?;
            surface_ap.verify_code_a(&code_a)?;

            let certificate = surface_ap.read_certificate()?;
            certificate.verify()?;
            let face = surface_ap.read_card_face()?;
            face.verify(&certificate.public_key)?;
            if face.birth_date != attributes.birth_date || face.sex != attributes.sex {
                return Err(Error::SignatureInvalid(
                    "the text and rendered card-face records disagree".into(),
                ));
            }

            let challenge = surface_ap.card().get_challenge(16)?;
            let signature = surface_ap.sign(&challenge)?;
            SignatureScheme::Sha256DigestInfo.verify(&face.public_key, &challenge, &signature)?;

            let photo_png = jpeg2000_to_png(&face.photo.data)?;
            Ok(CardIdentity {
                name: attributes.name,
                address: attributes.address,
                birth_date: attributes.birth_date.to_string(),
                sex: sex_code(attributes.sex),
                expiry: face.expiry.to_string(),
                name_image: CardImage::png(&face.name_image.data),
                address_image: CardImage::png(&face.address_image.data),
                photo_preview: CardImage::png(&photo_png),
                photo_original: CardImage::jpeg2000(&face.photo.data),
                data_verified: true,
                card_present_verified: true,
                // `myna-card` documents DF29 as being after DF28, outside the signed segments.
                expiry_covered_by_signature: false,
            })
        })();
        finish_with_reset(result, self.reset_security_status())
    }

    /// Change one of the three credentials exposed by `myna pin change`.
    ///
    /// Both strings are zeroed before any APDU is sent. Shape validation and a blocked-counter
    /// check happen first; only then is the current value presented. The card is returned to the
    /// master-file state even when the current value is wrong.
    pub fn change_pin(
        &mut self,
        kind: PinKind,
        current: &mut String,
        new_value: &mut String,
    ) -> Result<()> {
        let current_result = credential(kind, current.as_bytes());
        let new_result = credential(kind, new_value.as_bytes());
        current.zeroize();
        new_value.zeroize();
        let current = current_result?;
        let new_value = new_result?;

        self.invalidate_jpki_cache();
        let result = (|| match kind {
            PinKind::Card => {
                let mut text_ap = TextAp::select(&mut self.card)?;
                ensure_not_blocked(text_ap.retries(text::ef::PIN)?)?;
                text_ap
                    .change_pin(&current, &new_value)
                    .map_err(Error::from)
            }
            PinKind::Auth => {
                let mut jpki = JpkiAp::select(&mut self.card)?;
                ensure_not_blocked(jpki.auth_pin_retries()?)?;
                jpki.change_auth_pin(&current, &new_value)
                    .map_err(Error::from)
            }
            PinKind::Sign => {
                let mut jpki = JpkiAp::select(&mut self.card)?;
                ensure_not_blocked(jpki.sign_pin_retries()?)?;
                jpki.change_sign_pin(&current, &new_value)
                    .map_err(Error::from)
            }
        })();
        finish_with_reset(result, self.reset_security_status())
    }

    /// Attempts left on the signature password, without spending one.
    pub fn sign_pin_retries(&mut self) -> Result<Retries> {
        let mut jpki = JpkiAp::select(&mut self.card)?;
        Ok(jpki.sign_pin_retries()?)
    }

    /// Present the signature password and read the 署名用証明書.
    ///
    /// The password is consumed and zeroed. The certificate is kept for the rest of the session so
    /// that signing does not have to ask again.
    ///
    /// # Errors
    ///
    /// [`Error::Card`] wrapping [`myna_card::Error::PinBlocked`] if the key is already blocked —
    /// checked *before* presenting anything, so a blocked key does not cost the caller an attempt
    /// to discover.
    ///
    /// # Warning
    ///
    /// **The 署名用証明書 carries the holder's 氏名, 住所, 生年月日 and 性別.** Anything that
    /// displays or writes out the result is disclosing them.
    pub fn unlock(&mut self, password: &mut String) -> Result<CertificateInfo> {
        let pin = Pin::new(password.as_bytes());
        password.zeroize();
        let pin = pin?;

        if let Retries::Blocked = self.sign_pin_retries()? {
            return Err(Error::Card(myna_card::Error::PinBlocked));
        }

        let mut jpki = JpkiAp::select(&mut self.card)?;
        jpki.verify_sign_pin(&pin)?;

        let certificate = jpki.read_sign_certificate()?;
        // The CA above it, so that a signature can carry a chain a verifier can walk without
        // having the card. Not fatal if it will not read: the signature is still valid, and a
        // verifier can reach a J-LIS root without it.
        self.sign_ca_certificate = jpki.read_sign_ca_certificate().ok();

        let info = CertificateInfo::read(&certificate)?;
        self.sign_certificate = Some(certificate);
        Ok(info)
    }

    /// Read the protected signing certificate and CA, then immediately clear JPKI VERIFY.
    ///
    /// This is the desktop equivalent of `myna jpki cert -t sign` and `-t sign_ca`. Unlike
    /// [`CardSession::unlock`], it is an inspection operation: the private key is not left ready
    /// for a later signature.
    pub fn read_sign_certificates(&mut self, password: &mut String) -> Result<SignCertificates> {
        let result = (|| {
            let certificate = self.unlock(password)?;
            let ca_certificate = self.sign_ca_certificate()?;
            Ok(SignCertificates {
                certificate,
                ca_certificate,
            })
        })();
        finish_with_reset(result, self.reset_security_status())
    }

    /// Whether the signature password has been presented in this session.
    pub fn unlocked(&self) -> bool {
        self.sign_certificate.is_some()
    }

    /// A signer for the 署名用秘密鍵.
    ///
    /// # Errors
    ///
    /// [`Error::NotChecked`] if [`CardSession::unlock`] has not run — the certificate the signer
    /// has to show is itself behind the password.
    pub fn signer(&mut self) -> Result<CardSigner<'_>> {
        let certificate = self.sign_certificate.clone().ok_or_else(|| {
            Error::NotChecked("the signature password has not been presented".into())
        })?;
        Ok(CardSigner {
            session: self,
            certificate,
        })
    }

    /// The CA certificate above the 署名用証明書, DER, once the session is unlocked.
    ///
    /// Goes into a CMS structure as an extra certificate so a verifier can build the chain.
    pub fn sign_ca_certificate_der(&self) -> Option<Vec<u8>> {
        self.sign_ca_certificate.as_ref().map(|c| c.der().to_vec())
    }

    fn invalidate_jpki_cache(&mut self) {
        self.sign_certificate = None;
        self.sign_ca_certificate = None;
    }

    fn reset_security_status(&mut self) -> Result<()> {
        self.invalidate_jpki_cache();
        select_master_file(&mut self.card)?;
        Ok(())
    }

    /// Clear the JPKI security status and disconnect.
    ///
    /// Selects the master-file state, which leaves the JPKI application and clears the VERIFY
    /// state without interrupting power. Call it; do not rely on merely dropping the connection.
    pub fn close(mut self) -> Result<()> {
        self.clear_security_status()
    }

    fn clear_security_status(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.reset_security_status()?;
        self.closed = true;
        Ok(())
    }
}

fn ensure_not_blocked(retries: Retries) -> Result<()> {
    if matches!(retries, Retries::Blocked) {
        Err(Error::Card(myna_card::Error::PinBlocked))
    } else {
        Ok(())
    }
}

fn four_digit_pin(value: &[u8]) -> Result<Pin> {
    if value.len() != 4 || !value.iter().all(u8::is_ascii_digit) {
        return Err(Error::Card(myna_card::Error::InvalidPin(
            "must be exactly four decimal digits",
        )));
    }
    Ok(Pin::numeric(value)?)
}

fn credential(kind: PinKind, value: &[u8]) -> Result<Pin> {
    match kind {
        PinKind::Card | PinKind::Auth => four_digit_pin(value),
        PinKind::Sign => {
            if !(6..=16).contains(&value.len())
                || !value
                    .iter()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            {
                return Err(Error::Card(myna_card::Error::InvalidPin(
                    "must be 6 to 16 uppercase ASCII letters or digits",
                )));
            }
            Ok(Pin::new(value)?)
        }
    }
}

fn sex_code(sex: myna_card::data::Sex) -> String {
    match sex {
        myna_card::data::Sex::Male => "1".into(),
        myna_card::data::Sex::Female => "2".into(),
        myna_card::data::Sex::Unknown => "0".into(),
        myna_card::data::Sex::NotApplicable => "9".into(),
        myna_card::data::Sex::Other(value) => char::from(value).to_string(),
    }
}

fn jpeg2000_to_png(data: &[u8]) -> Result<Vec<u8>> {
    let decoder = hayro_jpeg2000::integration::Jp2Decoder::new(Cursor::new(data))
        .map_err(|error| Error::malformed(format!("JPEG 2000 photograph: {error}")))?;
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| Error::malformed(format!("JPEG 2000 photograph: {error}")))?;
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|error| Error::malformed(format!("PNG photograph preview: {error}")))?;
    Ok(png.into_inner())
}

fn finish_with_reset<T>(operation: Result<T>, reset: Result<()>) -> Result<T> {
    match (operation, reset) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn select_master_file<T: myna_card::transport::Transmit>(
    card: &mut Card<T>,
) -> myna_card::Result<()> {
    MasterFile::select(card)?;
    Ok(())
}

impl Drop for CardSession {
    /// A last resort, not the intended path.
    ///
    /// [`CardSession::close`] reports whether the master-file state was selected; this cannot, and
    /// a failure here leaves the signature key unlocked with nobody told. It is here so that an
    /// early return or a panic does not leave the card open, not so that callers can ignore
    /// `close`.
    fn drop(&mut self) {
        let _ = self.clear_security_status();
    }
}

/// The 署名用秘密鍵, as something `myna-sign` can sign with.
#[derive(Debug)]
pub struct CardSigner<'a> {
    session: &'a mut CardSession,
    certificate: Certificate,
}

impl DigestSigner for CardSigner<'_> {
    fn certificate(&self) -> &Certificate {
        &self.certificate
    }

    /// Sign with `CLA 80 INS 2A`, P1 = 02.
    ///
    /// `PreHashedDigestInfo` is the only scheme that fits: the digest here is over bytes the core
    /// assembled — an OpenPGP trailer, or a set of CMS attributes — not over a file the card could
    /// hash for itself, and the card's hash-on-card modes cap the input at what a short APDU
    /// carries anyway.
    fn sign_sha256(&mut self, digest: &[u8; 32]) -> Result<Vec<u8>> {
        // Re-selecting the application does not clear its security status (JICSAP 5.1.3 rule 2),
        // so this is free and keeps the session from having to hold a borrow between signatures.
        let mut jpki = JpkiAp::select(&mut self.session.card)?;
        Ok(jpki.sign_with_sign_key(SignatureScheme::PreHashedDigestInfo, digest)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myna_card::transport::Transmit;

    #[derive(Debug, Default)]
    struct RecordingTransport {
        sent: Vec<Vec<u8>>,
    }

    impl Transmit for RecordingTransport {
        fn transmit(&mut self, command: &[u8]) -> myna_card::Result<Vec<u8>> {
            self.sent.push(command.to_vec());
            Ok(vec![0x90, 0x00])
        }
    }

    /// The card layer cannot be exercised without a card; what can be checked here is that the
    /// types line up, so a change to `DigestSigner` breaks the build rather than the card.
    #[test]
    fn the_card_signer_is_a_digest_signer() {
        fn assert_impl<T: DigestSigner>() {}
        assert_impl::<CardSigner<'_>>();
    }

    #[test]
    fn resetting_the_security_status_selects_the_master_file_state() {
        let mut card = Card::new(RecordingTransport::default());
        select_master_file(&mut card).unwrap();

        assert_eq!(
            card.transport().sent,
            [vec![
                0x00, 0xA4, 0x04, 0x0C, 0x07, 0xA0, 0x00, 0x00, 0x01, 0x51, 0x00, 0x00,
            ]]
        );
    }

    #[test]
    fn four_digit_credentials_are_rejected_before_the_card() {
        for invalid in [b"123".as_slice(), b"12345", b"12A4", "１２３４".as_bytes()] {
            assert!(matches!(
                four_digit_pin(invalid),
                Err(Error::Card(myna_card::Error::InvalidPin(_)))
            ));
        }
        four_digit_pin(b"1234").unwrap();
    }

    #[test]
    fn signing_password_shape_matches_jpki_rules() {
        for invalid in [
            b"ABCDE".as_slice(),
            b"ABCDEFGHIJKLMNOPQ",
            b"abc123",
            b"ABC-123",
        ] {
            assert!(matches!(
                credential(PinKind::Sign, invalid),
                Err(Error::Card(myna_card::Error::InvalidPin(_)))
            ));
        }
        credential(PinKind::Sign, b"ABC123").unwrap();
        credential(PinKind::Sign, b"1234567890ABCDEF").unwrap();
    }

    #[test]
    fn listing_readers_does_not_panic_without_a_reader() {
        // On a machine with no pcscd this is an error, not a crash, and the interface has to be
        // able to show it.
        match list_readers() {
            Ok(readers) => println!("{} reader(s)", readers.len()),
            Err(e) => println!("no readers: {e}"),
        }
    }
}
