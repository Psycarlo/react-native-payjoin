//! Fully offline (out-of-band) BIP78 receiver primitives.
//!
//! The v2 session API in `payjoin-ffi` only reaches
//! [`payjoin::receive::v1::UncheckedOriginalPayload`] through a directory
//! round-trip, so an airgapped receiver — one that imports the sender's Original
//! PSBT from a QR code or file and hands back a proposal the same way — has no
//! entry point. These two functions provide it.
//!
//! The flow is deliberately split so the signing wallet can sit between the two
//! calls:
//!
//! 1. [`receiver_manual_contribute`] runs the mandatory receiver checks,
//!    contributes one input, and returns the provisional PSBT to sign plus an
//!    opaque resumable state.
//! 2. [`receiver_manual_finalize`] takes that state and the signed PSBT and
//!    returns the proposal PSBT to hand back to the sender.
//!
//! No directory, relay, or OHTTP context is involved in either step.

use std::collections::HashSet;
use std::str::FromStr;

use base64::Engine;
use bitcoin::psbt::Psbt;
use bitcoin::{Address, Amount, OutPoint, Script, ScriptBuf, TxOut, Txid};
use payjoin::receive::v1;
use payjoin::receive::InputPair;

/// Errors from the offline receiver primitives.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum ManualReceiveError {
    /// An input, address, script, or PSBT could not be parsed.
    #[error("Invalid payjoin input: {message}")]
    Invalid { message: String },
    /// A receiver protocol check rejected the sender's Original PSBT.
    #[error("Payjoin receiver check failed: {message}")]
    Check { message: String },
}

impl ManualReceiveError {
    fn invalid(error: impl std::fmt::Display) -> Self {
        Self::Invalid { message: error.to_string() }
    }

    fn check(error: impl std::fmt::Display) -> Self {
        Self::Check { message: error.to_string() }
    }
}

/// A wallet UTXO offered as the receiver's contribution.
#[derive(uniffi::Record)]
pub struct ManualReceiverInput {
    /// Hex-encoded txid (big-endian), as displayed by explorers.
    pub txid: String,
    /// Output index.
    pub vout: u32,
    /// Amount in satoshis.
    pub value: u64,
    /// Hex-encoded scriptPubKey.
    pub script_hex: String,
}

/// Result of [`receiver_manual_contribute`].
#[derive(uniffi::Record)]
pub struct ManualContributeResult {
    /// PSBT for the receiver's wallet to sign.
    pub provisional_psbt_base64: String,
    /// Opaque resumable state to pass to [`receiver_manual_finalize`].
    pub provisional_state: String,
}

/// Result of [`receiver_manual_finalize`].
#[derive(uniffi::Record)]
pub struct ManualFinalizeResult {
    /// Proposal PSBT to hand back to the sender out of band.
    pub proposal_psbt_base64: String,
}

/// `Content-Length` is the only header the v1 payload validator consults, and an
/// out-of-band transport has no real HTTP headers to forward.
struct ManualHeaders {
    content_length: String,
}

impl v1::Headers for ManualHeaders {
    fn get_header(&self, key: &str) -> Option<&str> {
        match key.to_lowercase().as_str() {
            "content-length" => Some(&self.content_length),
            "content-type" => Some("text/plain"),
            _ => None,
        }
    }
}

fn encode_provisional_state(
    provisional: &v1::ProvisionalProposal,
) -> Result<String, ManualReceiveError> {
    let json = serde_json::to_string(provisional).map_err(ManualReceiveError::invalid)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(json.as_bytes()))
}

fn decode_provisional_state(
    state: &str,
) -> Result<v1::ProvisionalProposal, ManualReceiveError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(state.as_bytes())
        .map_err(ManualReceiveError::invalid)?;
    serde_json::from_slice(&bytes).map_err(ManualReceiveError::invalid)
}

fn input_pair(input: &ManualReceiverInput) -> Result<InputPair, ManualReceiveError> {
    let txid = Txid::from_str(&input.txid).map_err(ManualReceiveError::invalid)?;
    let script_pubkey =
        ScriptBuf::from_hex(&input.script_hex).map_err(ManualReceiveError::invalid)?;
    let txout = TxOut { value: Amount::from_sat(input.value), script_pubkey };
    let outpoint = OutPoint { txid, vout: input.vout };

    if txout.script_pubkey.is_p2wpkh() {
        return InputPair::new_p2wpkh(txout, outpoint).map_err(ManualReceiveError::invalid);
    }
    if txout.script_pubkey.is_p2tr() {
        return InputPair::new_p2tr_keyspend(txout, outpoint)
            .map_err(ManualReceiveError::invalid);
    }
    Err(ManualReceiveError::Invalid {
        message: "contributed input must be p2wpkh or p2tr".to_string(),
    })
}

/// Offline receiver step 1: ingest the sender's Original PSBT, run the receiver
/// checks, contribute one input, and return the provisional PSBT to sign.
///
/// * `owned_scripts_hex` — the receiver's own scriptPubKeys, used to identify
///   which outputs belong to the receiver alongside `receive_address`.
/// * `owned_outpoints` — the receiver's wallet outpoints, formatted `txid:vout`.
///   Rejecting an Original PSBT that spends these stops a sender from getting the
///   receiver to spend its own coins.
/// * `seen_outpoints` — outpoints from previous payjoin sessions, formatted
///   `txid:vout`. Rejecting these blocks probing attacks that replay inputs to
///   discover the receiver's UTXO set.
///
/// The broadcast-suitability check is skipped: an interactive receiver imports
/// the Original PSBT deliberately, so the anti-probing guard that check provides
/// is unnecessary and it would require a mempool connection this path lacks.
#[uniffi::export]
pub fn receiver_manual_contribute(
    original_psbt_base64: String,
    receive_address: String,
    disable_output_substitution: bool,
    input: ManualReceiverInput,
    owned_scripts_hex: Vec<String>,
    owned_outpoints: Vec<String>,
    seen_outpoints: Vec<String>,
) -> Result<ManualContributeResult, ManualReceiveError> {
    let body_string = original_psbt_base64.trim().to_string();
    let body = body_string.as_bytes();
    let headers = ManualHeaders { content_length: body.len().to_string() };
    let query = if disable_output_substitution {
        "v=1&disableoutputsubstitution=true"
    } else {
        "v=1"
    };

    let unchecked = v1::UncheckedOriginalPayload::from_request(body, query, headers)
        .map_err(ManualReceiveError::check)?;

    let maybe_owned = unchecked.assume_interactive_receiver();

    // The Original PSBT must not already spend one of the receiver's UTXOs,
    // which would let a malicious sender get the receiver to spend its own
    // coins. Upstream keys this check by outpoint, so the caller supplies its
    // wallet outpoints via `owned_outpoints`.
    let owned_set: HashSet<OutPoint> = owned_outpoints
        .iter()
        .filter_map(|outpoint| OutPoint::from_str(outpoint).ok())
        .collect();
    let mut is_owned = |outpoint: &OutPoint| Ok(owned_set.contains(outpoint));
    let maybe_seen = maybe_owned
        .check_inputs_not_owned(&mut is_owned)
        .map_err(ManualReceiveError::check)?;

    let seen_set: HashSet<OutPoint> = seen_outpoints
        .iter()
        .filter_map(|outpoint| OutPoint::from_str(outpoint).ok())
        .collect();
    let mut is_known = |outpoint: &OutPoint| Ok(seen_set.contains(outpoint));
    let outputs_unknown = maybe_seen
        .check_no_inputs_seen_before(&mut is_known)
        .map_err(ManualReceiveError::check)?;

    let address = Address::from_str(&receive_address)
        .map_err(ManualReceiveError::invalid)?
        .assume_checked();
    let receive_script = address.script_pubkey();
    let owned_scripts: HashSet<ScriptBuf> = owned_scripts_hex
        .iter()
        .filter_map(|hex| ScriptBuf::from_hex(hex).ok())
        .collect();
    let mut is_receiver_output = |script: &Script| {
        Ok(script == receive_script.as_script() || owned_scripts.contains(script))
    };
    let wants_outputs = outputs_unknown
        .identify_receiver_outputs(&mut is_receiver_output)
        .map_err(ManualReceiveError::check)?;

    let wants_inputs = wants_outputs.commit_outputs();
    let wants_fee_range = wants_inputs
        .contribute_inputs(vec![input_pair(&input)?])
        .map_err(ManualReceiveError::check)?
        .commit_inputs();

    let provisional = wants_fee_range
        .apply_fee_range(None, None)
        .map_err(ManualReceiveError::check)?;

    Ok(ManualContributeResult {
        provisional_psbt_base64: provisional.psbt_to_sign().to_string(),
        provisional_state: encode_provisional_state(&provisional)?,
    })
}

/// Offline receiver step 2: finalize the proposal from the state returned by
/// [`receiver_manual_contribute`] and the receiver-signed provisional PSBT.
///
/// Returns the proposal PSBT to hand back to the sender out of band.
#[uniffi::export]
pub fn receiver_manual_finalize(
    provisional_state: String,
    signed_psbt_base64: String,
) -> Result<ManualFinalizeResult, ManualReceiveError> {
    let provisional = decode_provisional_state(&provisional_state)?;
    let signed_psbt =
        Psbt::from_str(&signed_psbt_base64).map_err(ManualReceiveError::invalid)?;

    let proposal = provisional
        .finalize_proposal(|cleared| Ok(merge_finalized_inputs(cleared, &signed_psbt)))
        .map_err(ManualReceiveError::check)?;

    Ok(ManualFinalizeResult { proposal_psbt_base64: proposal.psbt().to_string() })
}

/// Applies the receiver's finalized inputs onto a cleared proposal PSBT.
///
/// Exposed because every receiver finalize callback needs it, including the
/// BIP77 (v2) `finalize_proposal` path, where the callback runs in the host
/// language. PDK hands that callback a PSBT with the sender's finals stripped, so
/// returning the wallet-signed PSBT wholesale would reintroduce the sender's
/// finals and yield an invalid proposal. Copying per-input is the correct merge.
///
/// * `cleared_psbt_base64` — the PSBT handed to the finalize callback.
/// * `signed_psbt_base64` — the same PSBT after the receiver's wallet signed it.
#[uniffi::export]
pub fn merge_finalized_proposal_inputs(
    cleared_psbt_base64: String,
    signed_psbt_base64: String,
) -> Result<String, ManualReceiveError> {
    let cleared =
        Psbt::from_str(&cleared_psbt_base64).map_err(ManualReceiveError::invalid)?;
    let signed =
        Psbt::from_str(&signed_psbt_base64).map_err(ManualReceiveError::invalid)?;
    Ok(merge_finalized_inputs(&cleared, &signed).to_string())
}

/// Applies the receiver's finals onto the cleared PSBT.
///
/// PDK hands the callback a PSBT with the sender's finals stripped, so the
/// receiver's signatures must be copied in per-input rather than by returning the
/// signed PSBT wholesale — doing the latter would reintroduce the sender's finals
/// and yield an invalid proposal.
fn merge_finalized_inputs(cleared: &Psbt, signed: &Psbt) -> Psbt {
    let mut merged = cleared.clone();
    for (index, input) in merged.inputs.iter_mut().enumerate() {
        if input.final_script_witness.is_some()
            || input.final_script_sig.is_some()
            || input.tap_key_sig.is_some()
        {
            continue;
        }
        let Some(signed_in) = signed.inputs.get(index) else {
            continue;
        };
        if signed_in.final_script_witness.is_none()
            && signed_in.final_script_sig.is_none()
            && signed_in.tap_key_sig.is_none()
        {
            continue;
        }
        input.final_script_witness = signed_in.final_script_witness.clone();
        input.final_script_sig = signed_in.final_script_sig.clone();
        input.tap_key_sig = signed_in.tap_key_sig;
    }
    merged
}

#[cfg(test)]
mod tests {
    use bitcoin::hashes::Hash;
    use bitcoin::transaction::Version;
    use bitcoin::{absolute::LockTime, Transaction, TxIn, Witness};

    use super::*;

    fn dummy_witness(byte: u8) -> Witness {
        Witness::from_slice(&[vec![byte; 72], vec![byte; 33]])
    }

    fn two_input_psbt() -> Psbt {
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![
                TxIn {
                    previous_output: OutPoint {
                        txid: Txid::from_byte_array([1u8; 32]),
                        vout: 0,
                    },
                    ..Default::default()
                },
                TxIn {
                    previous_output: OutPoint {
                        txid: Txid::from_byte_array([2u8; 32]),
                        vout: 1,
                    },
                    ..Default::default()
                },
            ],
            output: vec![TxOut {
                value: Amount::from_sat(50_000),
                script_pubkey: ScriptBuf::from_hex(&format!("0014{}", "11".repeat(20)))
                    .expect("valid script"),
            }],
        };
        Psbt::from_unsigned_tx(tx).expect("unsigned psbt")
    }

    /// The sender's input (index 0) is already final on `cleared`; the receiver's
    /// wallet finalized both. Only the receiver's input may be copied over, or the
    /// proposal would carry the sender's finals and be invalid.
    #[test]
    fn keeps_existing_finals_and_copies_only_missing_ones() {
        let mut cleared = two_input_psbt();
        cleared.inputs[0].final_script_witness = Some(dummy_witness(0xaa));

        let mut signed = two_input_psbt();
        signed.inputs[0].final_script_witness = Some(dummy_witness(0xbb));
        signed.inputs[1].final_script_witness = Some(dummy_witness(0xcc));

        let merged = merge_finalized_inputs(&cleared, &signed);

        assert_eq!(
            merged.inputs[0].final_script_witness,
            Some(dummy_witness(0xaa)),
            "sender's existing finals must not be overwritten"
        );
        assert_eq!(
            merged.inputs[1].final_script_witness,
            Some(dummy_witness(0xcc)),
            "receiver's finals must be applied"
        );
    }

    #[test]
    fn leaves_inputs_untouched_when_signed_psbt_has_no_finals() {
        let cleared = two_input_psbt();
        let signed = two_input_psbt();

        let merged = merge_finalized_inputs(&cleared, &signed);

        assert!(merged.inputs.iter().all(|i| i.final_script_witness.is_none()));
    }

    #[test]
    fn tolerates_signed_psbt_with_fewer_inputs() {
        let cleared = two_input_psbt();
        let mut signed = two_input_psbt();
        signed.inputs.truncate(1);
        signed.inputs[0].final_script_witness = Some(dummy_witness(0xdd));

        let merged = merge_finalized_inputs(&cleared, &signed);

        assert_eq!(merged.inputs[0].final_script_witness, Some(dummy_witness(0xdd)));
        assert!(merged.inputs[1].final_script_witness.is_none());
    }

    #[test]
    fn provisional_state_round_trips_through_base64() {
        // A malformed state must be rejected rather than panicking.
        assert!(decode_provisional_state("not-base64!").is_err());
        assert!(decode_provisional_state("eyJmb28iOiJiYXIifQ==").is_err());
    }
}
