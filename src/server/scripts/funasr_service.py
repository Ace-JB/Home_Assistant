import sys
import argparse
import logging
import os
import contextlib

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

def create_model(model_name, cache_dir):
    silence()
    try:
        if cache_dir:
            os.environ["MODELSCOPE_CACHE"] = os.path.abspath(cache_dir)
        
        # 暂时移除标点模型 (Punc) 以解决 "not registered" 崩溃问题
        # 保留 ASR 和 VAD 模型，这是解决幻觉的关键
        model = AutoModel(
            model=model_name,
            model_revision="v2.0.4",
            vad_model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            vad_model_revision="v2.0.4",
            disable_update=True,
            device="cpu", 
            max_end_silence_time=1000,
            max_single_segment_time=100000,
        )
        return model
    finally:
        restore()

def main():
    parser = argparse.ArgumentParser(description="FunASR Persistent Service")
    parser.add_argument("--model", type=str, required=True, help="Model name or path")
    parser.add_argument("--cache", type=str, help="Path to the model cache directory")
    args = parser.parse_args()

    # 1. 初始化并预加载模型 (ASR + VAD)
    try:
        model = create_model(args.model, args.cache)
    except Exception as e:
        restore()
        print(f"CRITICAL_ERROR:Model initialization failed: {e}", file=sys.stderr)
        sys.exit(1)
    
    # 2. 通知 Node.js 准备就绪
    print("READY", flush=True)

    # 3. 循环监听 stdin 中的文件路径
    try:
        for line in sys.stdin:
            audio_path = line.strip()
            if not audio_path:
                continue
            
            if audio_path == "EXIT":
                break

            if not os.path.exists(audio_path):
                print(f"ERROR:File not found: {audio_path}", flush=True)
                continue

            try:
                silence()
                # 使用 VAD 过滤非人声音频
                res = model.generate(input=audio_path, batch_size_s=300)
                restore()
                
                text = res[0]['text'] if res and len(res) > 0 else ""
                print(f"RESULT:{text.strip()}", flush=True)
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
