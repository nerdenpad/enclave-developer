"""Enforcement for NEAR's ECDSA + SPKI report format; no inference or credentials.

Intel quote signatures/collateral use dcap-qvl's compiled Rust verifier and pinned
Intel root. NVIDIA results are ES384 verified against the fixed HTTPS NRAS JWKS.
Hardware validity and authorization of the measured workload are separate steps.
"""
import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timezone

import dcap_qvl
import jwt
import requests

MAX_DOCUMENT_BYTES = 2_000_000
NRAS_ORIGIN = "https://nras.attestation.nvidia.com"
MEASUREMENTS = {
    "tee_tcb_svn": 16, "mr_seam": 48, "mr_signer_seam": 48,
    "seam_attributes": 8, "td_attributes": 8, "xfam": 8,
    "mr_td": 48, "mr_config_id": 48, "mr_owner": 48,
    "mr_owner_config": 48, "rt_mr0": 48, "rt_mr1": 48,
    "rt_mr2": 48, "rt_mr3": 48,
}
GPU_TRUE_CLAIMS = (
    "secboot", "x-nvidia-gpu-attestation-report-cert-chain-validated",
    "x-nvidia-gpu-attestation-report-signature-verified",
    "x-nvidia-gpu-attestation-report-nonce-match",
    "x-nvidia-gpu-attestation-report-parsed", "x-nvidia-gpu-arch-check",
    "x-nvidia-gpu-driver-rim-schema-validated",
    "x-nvidia-gpu-driver-rim-signature-verified", "x-nvidia-gpu-driver-rim-fetched",
    "x-nvidia-gpu-driver-rim-cert-validated",
    "x-nvidia-gpu-driver-rim-measurements-available",
    "x-nvidia-gpu-vbios-rim-schema-validated",
    "x-nvidia-gpu-vbios-rim-signature-verified", "x-nvidia-gpu-vbios-rim-fetched",
    "x-nvidia-gpu-vbios-rim-cert-validated",
    "x-nvidia-gpu-vbios-rim-measurements-available",
    "x-nvidia-gpu-vbios-index-no-conflict",
)


class VerificationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def parse_json(raw):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "INPUT_INVALID")
            result[key] = value
        return result

    def invalid_constant(_):
        raise VerificationError("INPUT_INVALID")

    try:
        return json.loads(raw, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError) as error:
        raise VerificationError("INPUT_INVALID") from error


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def hex_bytes(value, size, code="INPUT_INVALID"):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{%d}" % (size * 2), value), code)
    return bytes.fromhex(value)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp(value):
    try:
        require(isinstance(value, str) and value.endswith("Z"), "POLICY_INVALID")
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError) as error:
        raise VerificationError("POLICY_INVALID") from error


def validate_policy(policy, now):
    require(isinstance(policy, dict) and policy.get("schemaVersion") == 1, "POLICY_INVALID")
    require(isinstance(policy.get("version"), str) and 1 <= len(policy["version"]) <= 128, "POLICY_INVALID")
    start, end = timestamp(policy.get("validFrom")), timestamp(policy.get("validUntil"))
    require(start <= now < end, "POLICY_EXPIRED")
    session = policy.get("maxSessionSeconds")
    require(type(session) is int and 1 <= session <= 300, "POLICY_INVALID")
    profiles = policy.get("profiles")
    require(isinstance(profiles, list) and 1 <= len(profiles) <= 32, "POLICY_INVALID")
    for profile in profiles:
        require(isinstance(profile, dict), "POLICY_INVALID")
        require(isinstance(profile.get("model"), str) and profile["model"], "POLICY_INVALID")
        hex_bytes(profile.get("appComposeSha256"), 32, "POLICY_INVALID")
        hex_bytes(profile.get("composeManagerActionsSha256"), 32, "POLICY_INVALID")
        require(isinstance(profile.get("composeManagerImage"), str)
                and re.fullmatch(r"nearaidev/compose-manager@sha256:[0-9a-f]{64}", profile["composeManagerImage"]), "POLICY_INVALID")
        measurements = profile.get("measurements")
        require(isinstance(measurements, dict) and set(measurements) == set(MEASUREMENTS), "POLICY_INVALID")
        for key, size in MEASUREMENTS.items():
            hex_bytes(measurements[key], size, "POLICY_INVALID")
        require(type(profile.get("gpuCount")) is int and 1 <= profile["gpuCount"] <= 32, "POLICY_INVALID")
        require(isinstance(profile.get("gpuModels"), list) and profile["gpuModels"]
                and all(isinstance(model, str) and model for model in profile["gpuModels"]), "POLICY_INVALID")
    return end, session


async def verify_tdx(quote_hex):
    require(isinstance(quote_hex, str) and 1000 <= len(quote_hex) <= 131072
            and len(quote_hex) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]+", quote_hex), "CPU_INVALID")
    try:
        result = await asyncio.wait_for(dcap_qvl.get_collateral_and_verify(bytes.fromhex(quote_hex)), 45)
        return parse_json(result.to_json())
    except Exception as error:
        raise VerificationError("CPU_VERIFICATION_FAILED") from error


def cpu_claims(result):
    require(isinstance(result, dict), "CPU_INVALID")
    for item in (result, result.get("qe_status"), result.get("platform_status")):
        require(isinstance(item, dict) and item.get("status") == "UpToDate"
                and item.get("advisory_ids") == [], "CPU_TCB_REJECTED")
    report = result.get("report")
    # Formats with a different measured-report schema need explicit implementation.
    require(isinstance(report, dict) and set(report) == {"TD10"}, "CPU_TYPE_REJECTED")
    td = report["TD10"]
    require(isinstance(td, dict), "CPU_INVALID")
    for key, size in MEASUREMENTS.items():
        hex_bytes(td.get(key), size, "CPU_INVALID")
    require(int.from_bytes(hex_bytes(td["td_attributes"], 8), "little") & 1 == 0, "CPU_DEBUG_REJECTED")
    hex_bytes(td.get("report_data"), 64, "CPU_INVALID")
    hex_bytes(result.get("ppid"), 16, "CPU_INVALID")
    return {key: td[key].lower() for key in (*MEASUREMENTS, "report_data")}


def http_json(method, url, payload=None):
    # No caller-controlled URLs, proxy environment, netrc credentials, or redirects.
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.request(method, url, json=payload, timeout=(10, 40),
                                 allow_redirects=False, stream=True) as response:
                require(response.status_code == 200, "NVIDIA_UNAVAILABLE")
                data = bytearray()
                for chunk in response.iter_content(16384):
                    data.extend(chunk)
                    require(len(data) <= MAX_DOCUMENT_BYTES, "NVIDIA_INVALID")
                return parse_json(bytes(data))
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("NVIDIA_UNAVAILABLE") from error


def decode_nvidia(token, jwks, nonce, now):
    require(isinstance(token, str) and 1 <= len(token) <= 65536, "NVIDIA_INVALID")
    try:
        header = jwt.get_unverified_header(token)
        require(header.get("alg") == "ES384" and not any(k in header for k in ("jku", "x5u", "jwk", "crit")), "NVIDIA_SIGNATURE_INVALID")
        require(isinstance(header.get("kid"), str), "NVIDIA_SIGNATURE_INVALID")
        keys = [key for key in jwks["keys"] if key.get("kid") == header["kid"]]
        require(len(keys) == 1, "NVIDIA_SIGNATURE_INVALID")
        key = keys[0]
        require(key.get("kty") == "EC" and key.get("crv") == "P-384"
                and key.get("alg", "ES384") == "ES384" and key.get("use", "sig") == "sig", "NVIDIA_SIGNATURE_INVALID")
        # Validate time below against one trusted verification timestamp. Signature,
        # issuer, and lack of unsolicited audience are verified by PyJWT.
        claims = jwt.decode(token, jwt.PyJWK.from_dict(key).key, algorithms=["ES384"],
                            issuer=NRAS_ORIGIN, options={"verify_exp": False,
                            "verify_iat": False, "verify_nbf": False,
                            "require": ["iss", "exp", "iat", "nbf", "eat_nonce"]})
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("NVIDIA_SIGNATURE_INVALID") from error
    require(all(type(claims.get(k)) is int for k in ("iat", "nbf", "exp")), "NVIDIA_TIME_INVALID")
    require(claims["iat"] <= now + 5 and now - claims["iat"] <= 300
            and claims["nbf"] <= now + 5 and now < claims["exp"]
            and claims["iat"] <= claims["exp"], "NVIDIA_TIME_INVALID")
    require(hex_bytes(claims.get("eat_nonce"), 32, "NVIDIA_NONCE_INVALID") == nonce, "NVIDIA_NONCE_INVALID")
    return claims


def verify_nvidia_tokens(bundle, jwks, nonce, gpu_count, now):
    require(isinstance(bundle, list) and len(bundle) == 2 and isinstance(bundle[0], list)
            and len(bundle[0]) == 2 and bundle[0][0] == "JWT"
            and isinstance(bundle[1], dict), "NVIDIA_INVALID")
    require(isinstance(jwks, dict) and isinstance(jwks.get("keys"), list), "NVIDIA_INVALID")
    overall = decode_nvidia(bundle[0][1], jwks, nonce, now)
    require(overall.get("x-nvidia-ver") == "2.0"
            and overall.get("x-nvidia-overall-att-result") is True, "NVIDIA_RESULT_REJECTED")
    expected = {f"GPU-{n}" for n in range(gpu_count)}
    submods = overall.get("submods")
    require(isinstance(submods, dict) and set(submods) == expected
            and set(bundle[1]) == expected, "NVIDIA_GPU_SET_INVALID")
    devices, expirations, ueids = [], [overall["exp"]], set()
    for name in sorted(expected):
        token = bundle[1][name]
        require(isinstance(token, str), "NVIDIA_INVALID")
        require(submods[name] == ["DIGEST", ["SHA-256", digest(token.encode("ascii"))]], "NVIDIA_GPU_BINDING_INVALID")
        claims = decode_nvidia(token, jwks, nonce, now)
        require(claims.get("measres") == "success" and claims.get("dbgstat") == "disabled"
                and all(claims.get(key) is True for key in GPU_TRUE_CLAIMS)
                and claims.get("x-nvidia-attestation-warning") is None, "NVIDIA_GPU_REJECTED")
        ueid = claims.get("ueid")
        require(isinstance(ueid, str) and ueid and ueid not in ueids, "NVIDIA_GPU_SET_INVALID")
        ueids.add(ueid)
        require(isinstance(claims.get("hwmodel"), str) and claims["hwmodel"], "NVIDIA_GPU_REJECTED")
        devices.append(claims["hwmodel"])
        expirations.append(claims["exp"])
    return devices, min(expirations)


def action_value(value):
    # serde_json's canonical maps used by compose-manager; reject numeric values
    # rather than introducing Python/Rust floating-point serialization ambiguity.
    if isinstance(value, str) or value is None or type(value) is bool:
        return True
    if isinstance(value, list):
        return all(action_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and action_value(item) for key, item in value.items())
    return False


async def inspect_evidence(document):
    """Real crypto verification only; does NOT authorize a workload or return ok."""
    require(isinstance(document, dict), "INPUT_INVALID")
    nonce = hex_bytes(document.get("nonce"), 32)
    spki = hex_bytes(document.get("tlsSpkiSha256"), 32)
    a = document.get("attestation")
    require(isinstance(a, dict), "INPUT_INVALID")
    require(hex_bytes(a.get("request_nonce"), 32) == nonce, "NONCE_MISMATCH")
    require(a.get("signing_algo") == "ecdsa", "SIGNING_ALGORITHM_REJECTED")
    address = a.get("signing_address")
    require(isinstance(address, str) and address.startswith("0x"), "INPUT_INVALID")
    signer = hex_bytes(address[2:], 20)
    require(hex_bytes(a.get("tls_cert_fingerprint"), 32) == spki, "TLS_BINDING_MISMATCH")
    require(isinstance(a.get("model_name"), str) and a["model_name"], "INPUT_INVALID")
    cm = a.get("compose_manager_attestation")
    require(isinstance(cm, dict), "WORKLOAD_EVIDENCE_MISSING")
    main_result, cm_result = await asyncio.gather(verify_tdx(a.get("intel_quote")), verify_tdx(cm.get("quote")))
    main, manager = cpu_claims(main_result), cpu_claims(cm_result)
    require(main["report_data"] == digest(signer + spki) + nonce.hex(), "CPU_BINDING_MISMATCH")
    require(main_result["ppid"] == cm_result["ppid"]
            and all(main[k] == manager[k] for k in MEASUREMENTS), "WORKLOAD_VM_MISMATCH")
    actions = cm.get("actions")
    require(isinstance(actions, list) and 1 <= len(actions) <= 10000
            and all(isinstance(action, dict) for action in actions) and action_value(actions), "WORKLOAD_ACTIONS_INVALID")
    actions_hash = digest(canonical(actions))
    starts = [action for action in actions if action.get("action") == "compose_manager_started"]
    require(starts and isinstance(starts[-1].get("image"), str)
            and re.fullmatch(r"nearaidev/compose-manager@sha256:[0-9a-f]{64}", starts[-1]["image"]), "WORKLOAD_MANAGER_UNKNOWN")
    require(cm.get("nonce_source") == "client" and hex_bytes(cm.get("nonce"), 32) == nonce, "WORKLOAD_NONCE_MISMATCH")
    require(cm.get("actions_hash") == actions_hash
            and cm.get("report_data") == actions_hash + nonce.hex()
            and manager["report_data"] == actions_hash + nonce.hex(), "WORKLOAD_BINDING_MISMATCH")
    info = a.get("info")
    require(isinstance(info, dict), "WORKLOAD_EVIDENCE_MISSING")
    tcb = info.get("tcb_info")
    tcb = parse_json(tcb) if isinstance(tcb, str) else tcb
    require(isinstance(tcb, dict) and isinstance(tcb.get("app_compose"), str), "WORKLOAD_EVIDENCE_MISSING")
    app_hash = digest(tcb["app_compose"].encode("utf-8"))
    require(main["mr_config_id"] == "01" + app_hash + "00" * 15, "WORKLOAD_COMPOSE_MISMATCH")
    payload = parse_json(a.get("nvidia_payload")) if isinstance(a.get("nvidia_payload"), str) else a.get("nvidia_payload")
    require(isinstance(payload, dict) and payload.get("arch") in ("HOPPER", "BLACKWELL")
            and isinstance(payload.get("evidence_list"), list)
            and 1 <= len(payload["evidence_list"]) <= 32, "NVIDIA_INVALID")
    require(hex_bytes(payload.get("nonce"), 32) == nonce, "NVIDIA_NONCE_INVALID")
    for evidence in payload["evidence_list"]:
        require(isinstance(evidence, dict) and isinstance(evidence.get("evidence"), str)
                and isinstance(evidence.get("certificate"), str), "NVIDIA_INVALID")
    bundle, jwks = await asyncio.gather(
        asyncio.to_thread(http_json, "POST", NRAS_ORIGIN + "/v3/attest/gpu", payload),
        asyncio.to_thread(http_json, "GET", NRAS_ORIGIN + "/.well-known/jwks.json"))
    now = int(time.time())
    gpu_models, nvidia_exp = verify_nvidia_tokens(bundle, jwks, nonce, len(payload["evidence_list"]), now)
    measurements = {key: main[key] for key in MEASUREMENTS}
    return {"signingAddress": address.lower(), "tlsSpkiSha256": spki.hex(),
            "cpuStatus": "UpToDate", "gpuCount": len(gpu_models), "gpuModels": sorted(set(gpu_models)),
            "model": a["model_name"], "measurements": measurements,
            "appComposeSha256": app_hash, "composeManagerActionsSha256": actions_hash,
            "composeManagerImage": starts[-1]["image"],
            "nvidiaExpiresAt": nvidia_exp,
            "nvidiaEvidenceSha256": digest(canonical(bundle)), "nvidiaEvidence": bundle}


async def verify(document, policy):
    validate_policy(policy, time.time())
    started = time.time()
    facts = await inspect_evidence(document)
    now = int(time.time())
    end, session = validate_policy(policy, now)
    require(now - started <= 120, "VERIFICATION_TIMEOUT")
    keys = ("model", "measurements", "appComposeSha256", "composeManagerActionsSha256", "composeManagerImage", "gpuCount", "gpuModels")
    require(any(all(facts[key] == profile[key] for key in keys) for profile in policy["profiles"]), "WORKLOAD_NOT_APPROVED")
    expiry = min(now + session, int(end), facts["nvidiaExpiresAt"])
    require(expiry > now, "VERIFICATION_EXPIRED")
    reference = digest(canonical({"input": document, "policy": policy,
                                  "nvidiaEvidenceSha256": facts["nvidiaEvidenceSha256"]}))
    return {"ok": True, "signingAddress": facts["signingAddress"],
            "tlsSpkiSha256": facts["tlsSpkiSha256"], "attestationRef": "0x" + reference,
            "verifiedAt": iso(now), "expiresAt": iso(expiry),
            "cpuStatus": facts["cpuStatus"], "gpuCount": facts["gpuCount"],
            "measurements": facts["measurements"], "policyVersion": policy["version"],
            "policySha256": digest(canonical(policy)),
            "composeManagerActionsSha256": facts["composeManagerActionsSha256"],
            "composeManagerImage": facts["composeManagerImage"],
            "nvidiaEvidenceSha256": facts["nvidiaEvidenceSha256"],
            "nvidiaEvidence": facts["nvidiaEvidence"]}
