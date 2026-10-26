use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::PathBuf};

fn decode_wrapped_document(encoded: &str, label: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("Failed to decode outer base64 for {label}: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("{label} is not UTF-8: {error}"))
}

fn verify() -> Result<PathBuf, String> {
    let mut args = env::args().skip(1);
    let encoded_public_key = args
        .next()
        .ok_or_else(|| "Missing base64-wrapped updater public key".to_string())?;
    let artifact = PathBuf::from(
        args.next()
            .ok_or_else(|| "Missing artifact path".to_string())?,
    );
    let signature_path = PathBuf::from(
        args.next()
            .ok_or_else(|| "Missing signature path".to_string())?,
    );
    if args.next().is_some() {
        return Err("Unexpected extra arguments".to_string());
    }

    let public_key_document = decode_wrapped_document(&encoded_public_key, "updater public key")?;
    let public_key = PublicKey::decode(&public_key_document)
        .map_err(|error| format!("Invalid updater public key: {error}"))?;
    let encoded_signature = fs::read_to_string(&signature_path).map_err(|error| {
        format!(
            "Failed to read signature {}: {error}",
            signature_path.display()
        )
    })?;
    let signature_document = decode_wrapped_document(&encoded_signature, "updater signature")?;
    let signature = Signature::decode(&signature_document)
        .map_err(|error| format!("Invalid updater signature: {error}"))?;
    let bytes = fs::read(&artifact)
        .map_err(|error| format!("Failed to read artifact {}: {error}", artifact.display()))?;
    public_key
        .verify(&bytes, &signature, true)
        .map_err(|error| format!("Updater signature verification failed: {error}"))?;
    Ok(artifact)
}

fn main() {
    match verify() {
        Ok(artifact) => println!("Verified updater signature: {}", artifact.display()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
