import sys
import argparse
import logging
import os

#  在导入任何 AI 库之前，先重定向 FD 1 和 2 到 devnull，以彻底消除 C++ 层的日志输出
#  sys.stdout.write 只能影响 Python 层的输出，而 FD 重定向可以影响底层库
_stderr = os.dup(sys.stderr.fileno())
_stdout = os.dup(sys.stdout.fileno())
devnull = os.open(os.devnull, os.O_WRONLY)

def silence():
    os.dup2(devnull, sys.stdout.fileno())
    os.dup2(devnull, sys.stderr.fileno())

def restore():
    os.dup2(_stdout, sys.stdout.fileno())
    os.dup2(_stderr, sys.stderr.fileno())

# --- 1. 静默导入阶段 ---
silence()
try:
    os.environ["MODELSCOPE_LOG_LEVEL"] = "40"
    os.environ["FUNASR_LOG_LEVEL"] = "ERROR"
    from funasr import AutoModel
finally:
    restore()

def transcribe(audio_path, model_name, cache_dir):
    # --- 2. 静默初始化阶段 ---
    silence()
    try:
        model = AutoModel(
            model=model_name,
            model_revision="v2.0.4",
            disable_update=True,
            device="cpu",
            ncpu=1
        )
        # 执行识别
        res = model.generate(input=audio_path, batch_size_s=300)
    finally:
        restore()
    
    if res and len(res) > 0:
        return res[0]['text']
    return ""

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FunASR Inference Script")
    parser.add_argument("--audio", type=str, required=True, help="Path to the audio file")
    parser.add_argument("--model", type=str, required=True, help="Model name or path")
    parser.add_argument("--cache", type=str, help="Path to the model cache directory")
    args = parser.parse_args()
    
    if args.cache:
        os.environ["MODELSCOPE_CACHE"] = os.path.abspath(args.cache)
    
    if not os.path.exists(args.audio):
        print(f"Error: Audio file not found at {args.audio}", file=sys.stderr)
        sys.exit(1)

    try:
        text = transcribe(args.audio, args.model, args.cache)
        # 此时已经 restore() 了 stdout，可以正常输出结果
        # 只输出纯文本，不加任何前缀，方便后端直接读取
        print(text.strip())
    except Exception as e:
        # 确保在出错时也能恢复 stderr
        restore()
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        os.close(devnull)
        os.close(_stdout)
        os.close(_stderr)
