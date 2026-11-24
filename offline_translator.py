#!/usr/bin/env python3
"""Small JSON-lines worker for local English/Chinese translation."""
import json
import sys
from pathlib import Path

# The desktop preview may start Python with a legacy Windows code page.
# JSON-lines transport must always be UTF-8 in both directions.
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

import ctranslate2
import sentencepiece as spm

ROOT = Path(__file__).resolve().parent
MODEL_DIRS = {
    ("en", "zh"): ROOT / "models" / "en_zh" / "translate-en_zh-1_9",
    ("zh", "en"): ROOT / "models" / "zh_en" / "translate-zh_en-1_9",
}
models = {}


def load_model(pair):
    if pair not in models:
        model_dir = MODEL_DIRS[pair]
        translator = ctranslate2.Translator(
            str(model_dir / "model"),
            device="cpu",
            inter_threads=1,
            intra_threads=0,
            compute_type="int8",
        )
        # SentencePiece's native Windows loader cannot open some Unicode paths.
        # Reading the model bytes in Python keeps Chinese folder names portable.
        tokenizer = spm.SentencePieceProcessor(
            model_proto=(model_dir / "sentencepiece.model").read_bytes()
        )
        models[pair] = (translator, tokenizer)
    return models[pair]


def translate(text, pair):
    translator, tokenizer = load_model(pair)
    tokens = tokenizer.encode(text.strip(), out_type=str)
    if not tokens:
        return ""
    result = translator.translate_batch(
        [tokens],
        replace_unknowns=True,
        beam_size=2,
        num_hypotheses=1,
        length_penalty=0.2,
        max_decoding_length=256,
    )[0]
    return "".join(result.hypotheses[0]).replace("▁", " ").strip()


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


emit({"ready": True, "pairs": [list(pair) for pair in MODEL_DIRS]})
for line in sys.stdin:
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        pair = (request["source"], request["target"])
        if pair not in MODEL_DIRS:
            raise ValueError("unsupported offline language pair")
        translated = translate(request["text"], pair)
        emit({"id": request_id, "translation": translated})
    except Exception as error:
        emit({"id": request_id, "error": str(error)})
