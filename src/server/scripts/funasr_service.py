import sys
import argparse
import logging
import os
import contextlib
import json

# 彻底静默底层日志
_stderr = os.dup(sys.stderr.fileno())
_stdout = os.dup(sys.stdout.fileno())
devnull = os.open(os.devnull, os.O_WRONLY)

def silence():
    os.dup2(devnull, sys.stdout.fileno())
    os.dup2(devnull, sys.stderr.fileno())

def restore():
    os.dup2(_stdout, sys.stdout.fileno())
    os.dup2(_stderr, sys.stderr.fileno())

silence()
try:
    os.environ["MODELSCOPE_LOG_LEVEL"] = "40"
    os.environ["FUNASR_LOG_LEVEL"] = "ERROR"
    from funasr import AutoModel
finally:
    restore()

def create_model(model_name, cache_dir, punc_model=None, spk_model=None):
    silence()
    try:
        if cache_dir:
            os.environ["MODELSCOPE_CACHE"] = os.path.abspath(cache_dir)

        kwargs = dict(
            model=model_name,
            model_revision="v2.0.4",
            vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            vad_model_revision="v2.0.4",
            disable_update=True,
            device="cpu", 
            max_end_silence_time=1000,
            max_single_segment_time=100000,
        )
        if punc_model:
            kwargs["punc_model"] = punc_model
            kwargs["punc_model_revision"] = "v2.0.4"
        if spk_model:
            kwargs["spk_model"] = spk_model
            kwargs["spk_model_revision"] = "v2.0.2"
        model = AutoModel(**kwargs)
        return model
    finally:
        restore()

def normalize_segment(item, fallback_text=""):
    text = str(item.get("text") or fallback_text or "").strip()
    start = item.get("start")
    end = item.get("end")
    timestamp = item.get("timestamp")
    if (start is None or end is None) and isinstance(timestamp, list) and len(timestamp) > 0:
        first = timestamp[0]
        last = timestamp[-1]
        if isinstance(first, list) and len(first) >= 2:
            start = first[0]
        if isinstance(last, list) and len(last) >= 2:
            end = last[1]
    return {
        "start_ms": int(start or 0),
        "end_ms": int(end or 0),
        "text": text,
        "spk": str(item.get("spk") or item.get("speaker") or "SPK0"),
        "confidence": item.get("confidence") or item.get("score"),
    }

def normalize_result(res):
    if not res:
        return {"text": "", "segments": [], "raw": []}
    first = res[0] if isinstance(res, list) and len(res) > 0 else res
    if not isinstance(first, dict):
        return {"text": "", "segments": [], "raw": res}

    text = str(first.get("text") or "").strip()
    raw_segments = first.get("sentence_info")
    if not isinstance(raw_segments, list):
        raw_segments = first.get("segments")
    if not isinstance(raw_segments, list):
        raw_segments = []

    segments = [normalize_segment(item) for item in raw_segments if isinstance(item, dict)]
    if not segments and text:
        segments = [normalize_segment(first, text)]
    return {"text": text, "segments": segments, "raw": res}

def generate_with_timestamps(model, audio_path, mode):
    try:
        cfg = {"batch_size_s": 300, "sentence_timestamp": True, "pred_timestamp": True}
        if mode == "material":
            cfg["return_spk_res"] = True
        else:
            cfg["return_spk_res"] = False
        return model.generate(input=audio_path, **cfg)
    except TypeError:
        return model.generate(input=audio_path, batch_size_s=300)

def generate_material_analysis(model_with_spk, model_without_spk, audio_path):
    try:
        return generate_with_timestamps(model_with_spk, audio_path, "material")
    except Exception as e:
        if str(e).strip("'") != "timestamp":
            raise
        return model_without_spk.generate(
            input=audio_path,
            batch_size_s=300,
            sentence_timestamp=True,
            pred_timestamp=True,
            return_spk_res=False,
        )

def main():
    parser = argparse.ArgumentParser(description="FunASR Persistent Service")
    parser.add_argument("--model", type=str, required=True, help="Model name or path")
    parser.add_argument("--material-model", type=str, default="", help="Material analysis model name or path")
    parser.add_argument("--cache", type=str, help="Path to the model cache directory")
    parser.add_argument("--punc-model", type=str, default="", help="Punctuation model name or path")
    parser.add_argument("--spk-model", type=str, default="", help="Speaker diarization model name or path")
    args = parser.parse_args()

    # 1. 初始化并预加载模型 (ASR + VAD)
    try:
        model = create_model(args.model, args.cache, args.punc_model, args.spk_model)
        material_model = None
        material_fallback_model = None
        if args.material_model and args.material_model != args.model:
            material_model = create_model(args.material_model, args.cache, args.punc_model, args.spk_model)
            material_fallback_model = create_model(args.material_model, args.cache, args.punc_model, None)
    except Exception as e:
        restore()
        print(f"CRITICAL_ERROR:Model initialization failed: {e}", file=sys.stderr)
        sys.exit(1)
    
    # 2. 通知 Node.js 准备就绪
    print("READY", flush=True)

    # 3. 循环监听 stdin 中的文件路径
    try:
        for line in sys.stdin:
            raw_line = line.strip()
            mode = "text"
            audio_path = raw_line
            if raw_line.startswith("{"):
                try:
                    payload = json.loads(raw_line)
                    mode = payload.get("mode") or "text"
                    audio_path = payload.get("path") or ""
                except Exception:
                    print("ERROR:Invalid JSON request", flush=True)
                    continue
            else:
                audio_path = raw_line
            if not audio_path:
                continue
            
            if audio_path == "EXIT":
                break

            if not os.path.exists(audio_path):
                print(f"ERROR:File not found: {audio_path}", flush=True)
                continue

            try:
                silence()
                # 说话人日志依赖句级 timestamp；否则 FunASR 可能抛出 KeyError('timestamp')。
                active_model = material_model if mode == "material" and material_model is not None else model
                if mode == "material" and material_fallback_model is not None:
                    res = generate_material_analysis(active_model, material_fallback_model, audio_path)
                else:
                    res = generate_with_timestamps(active_model, audio_path, mode)
                restore()
                
                parsed = normalize_result(res)
                if mode in ("json", "material"):
                    print(f"JSON_RESULT:{json.dumps(parsed, ensure_ascii=False)}", flush=True)
                else:
                    print(f"RESULT:{parsed['text'].strip()}", flush=True)
            except Exception as e:
                restore()
                print(f"ERROR:{str(e)}", flush=True)
                
    except KeyboardInterrupt:
        pass
    finally:
        os.close(devnull)
        os.close(_stdout)
        os.close(_stderr)

if __name__ == "__main__":
    main()
