#!/usr/bin/env python3
"""model_tool.py -- build, sign and publish model bundles for the Iron mobile app.

Typical flow after you retrain in the notebook and have a new model.pkl (or new
reference_patches.json):

  # one-time: create a signing key (keep iron_signing_key.pem PRIVATE, never commit it)
  python tools/model_tool.py keygen --out-private iron_signing_key.pem --out-public-jwk public_key.jwk.json
  #   -> paste the printed JWK into config.js (UPDATE_PUBLIC_KEY)

  # every model release:
  python tools/model_tool.py publish --version 2 \
      --pkl "Iron App2/models/model.pkl" \
      --reference-patches "Iron App2/calibration_data/reference_patches.json" \
      --notes "Retrained on 600 photos incl. Samsung + Poco" \
      --sign-key iron_signing_key.pem --out-dir model/
  #   -> model/model-v2.json + model/latest.json ; deploy the model/ folder, done.

  # first-time export of the model that ships inside the app (version 1, unsigned file):
  python tools/model_tool.py export --version 1 --pkl ... --reference-patches ... --out model/model.json

For non-linear models pass --model-json my_model.json containing e.g.
  {"type":"piecewise_linear","x":[-0.2,-0.1,0,0.05],"y":[2.5,1.2,0.1,-0.1]}
or {"type":"polynomial","coefs":[a3,a2,a1,a0]}   (highest power first)
instead of --pkl.
"""
import argparse, base64, datetime, hashlib, json, sys
from pathlib import Path

PATCH_KEYS = ["0.0", "0.2", "0.5", "1.0", "1.5", "2.0", "2.5", "WHITE", "GRAY"]


def predict(model, x):
    t = model["type"]
    if t == "linear":
        return model["coef"] * x + model["intercept"]
    if t == "polynomial":
        acc = 0.0
        for c in model["coefs"]:
            acc = acc * x + c
        return acc
    if t == "piecewise_linear":
        X, Y = model["x"], model["y"]
        m = len(X)
        if x <= X[0]:
            k = 0
        elif x >= X[-1]:
            k = m - 2
        else:
            k = 0
            while k < m - 2 and x > X[k + 1]:
                k += 1
        return Y[k] + (x - X[k]) / (X[k + 1] - X[k]) * (Y[k + 1] - Y[k])
    raise SystemExit(f"unknown model type {t}")


def load_model(args):
    if args.model_json:
        return json.loads(Path(args.model_json).read_text())
    if args.pkl:
        import joblib  # needs scikit-learn of the version that wrote the pickle
        m = joblib.load(args.pkl)
        if len(m.coef_) != 1:
            raise SystemExit("Expected a 1-feature linear model; use --model-json for anything else.")
        return {"type": "linear", "coef": float(m.coef_[0]), "intercept": float(m.intercept_)}
    if args.coef is not None and args.intercept is not None:
        return {"type": "linear", "coef": args.coef, "intercept": args.intercept}
    raise SystemExit("Give --pkl, --model-json, or --coef and --intercept")


def build_bundle(args):
    model = load_model(args)
    rp = json.loads(Path(args.reference_patches).read_text())
    patches = rp.get("reference_patches", rp)
    missing = [k for k in PATCH_KEYS if patches.get(k) is None]
    if missing:
        raise SystemExit(f"reference patches missing/null: {missing}")
    xs = [-0.30, -0.15, -0.05, 0.0, 0.05, 0.15]
    bundle = {
        "schema": 1,
        "version": args.version,
        "released": args.released or datetime.date.today().isoformat(),
        "notes": args.notes or "",
        "min_app_version": args.min_app_version,
        "model": model,
        "calibrated_range": [args.range_low, args.range_high],
        "reference_patches": {k: float(patches[k]) for k in PATCH_KEYS},
        "uncertainty": {"same_family_mae": args.same_family_mae, "cross_brand_mae": args.cross_brand_mae},
        "reference_device_names": args.reference_device or ["nord", "ac2001"],
        "training": {"n_photos": args.n_photos, "note": args.training_note or ""},
        "selftest": [{"x": x, "y": predict(model, x)} for x in xs],
    }
    if args.extras_json:  # capture requirements, correction policy, uncertainty table, range tolerance (see model/bundle_extras.json)
        extras = json.loads(Path(args.extras_json).read_text())
        for k, v in extras.items():
            if k.startswith("_"): continue
            if k == "uncertainty": bundle["uncertainty"].update(v)
            else: bundle[k] = v
    return bundle


def dump(bundle):
    # canonical, deterministic bytes: what gets hashed and signed is exactly what is written
    return (json.dumps(bundle, indent=2, sort_keys=True) + "\n").encode()


def add_bundle_args(p):
    p.add_argument("--version", type=int, required=True, help="integer, must increase with every release")
    p.add_argument("--pkl")
    p.add_argument("--model-json")
    p.add_argument("--coef", type=float)
    p.add_argument("--intercept", type=float)
    p.add_argument("--reference-patches", required=True)
    p.add_argument("--notes")
    p.add_argument("--released")
    p.add_argument("--min-app-version", type=int, default=1)
    p.add_argument("--range-low", type=float, default=0.0)
    p.add_argument("--range-high", type=float, default=2.5)
    p.add_argument("--same-family-mae", type=float, default=0.08)
    p.add_argument("--cross-brand-mae", type=float, default=0.24)
    p.add_argument("--reference-device", action="append", help="lowercase substring of 'make model'; repeatable")
    p.add_argument("--n-photos", type=int, default=None)
    p.add_argument("--training-note")
    p.add_argument("--extras-json", help="JSON merged into the bundle: capture, correction, uncertainty, range_tolerance")


def cmd_export(a):
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(dump(build_bundle(a)))
    print("wrote", out)


def sign(key_path, data: bytes) -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
    return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()  # WebCrypto wants r||s


def cmd_publish(a):
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    data = dump(build_bundle(a))
    name = f"model-v{a.version}.json"
    (out / name).write_bytes(data)
    manifest = {
        "schema": 1,
        "version": a.version,
        "released": a.released or datetime.date.today().isoformat(),
        "notes": a.notes or "",
        "min_app_version": a.min_app_version,
        "bundle_url": name,
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    if a.sign_key:
        manifest["signature"] = sign(a.sign_key, data)
    else:
        print("WARNING: publishing UNSIGNED. The app will refuse it if config.js has an UPDATE_PUBLIC_KEY.", file=sys.stderr)
    (out / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("wrote", out / name, "and", out / "latest.json")


def cmd_keygen(a):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    Path(a.out_private).write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    n = key.public_key().public_numbers()
    b64u = lambda i: base64.urlsafe_b64encode(i.to_bytes(32, "big")).decode().rstrip("=")
    jwk = {"kty": "EC", "crv": "P-256", "x": b64u(n.x), "y": b64u(n.y), "ext": True}
    Path(a.out_public_jwk).write_text(json.dumps(jwk, indent=2) + "\n")
    print("private key ->", a.out_private, "(KEEP SECRET, do not commit)")
    print("public JWK  ->", a.out_public_jwk, "\n paste into config.js as UPDATE_PUBLIC_KEY:\n", json.dumps(jwk))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export"); add_bundle_args(e); e.add_argument("--out", required=True); e.set_defaults(fn=cmd_export)
    p = sub.add_parser("publish"); add_bundle_args(p); p.add_argument("--out-dir", required=True); p.add_argument("--sign-key"); p.set_defaults(fn=cmd_publish)
    k = sub.add_parser("keygen"); k.add_argument("--out-private", required=True); k.add_argument("--out-public-jwk", required=True); k.set_defaults(fn=cmd_keygen)
    args = ap.parse_args()
    args.fn(args)
