import { type Human } from "@vladmandic/human";

/**
 * Mid-Century Modern Renderer for Human AI results
 */
export class HumanRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;

    private colors = {
        walnut: "#6B4423",
        orange: "#E67E22",
        offWhite: "#F5F5F5",
        accent: "#D4A373"
    };

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not get 2D context");
        this.ctx = ctx;
    }

    /**
     * 清理画布
     */
    public clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * 绘制识别结果 (中世纪现代主义风格)
     */
    public draw(result: any) {
        this.clear();

        // 设置全局样式
        this.ctx.font = "500 16px 'Jost', 'Futura', sans-serif";
        this.ctx.lineWidth = 1.5;

        // 1. 绘制人脸结果
        if (result.face) {
            result.face.forEach((face: any) => {
                this.drawFaceBox(face);
                if (face.label && face.label !== "unknown") {
                    this.drawWelcomeLabel(face);
                }
            });
        }

        // 2. 绘制手势
        if (result.gesture) {
            this.drawGestures(result.gesture);
        }
    }

    private drawFaceBox(face: any) {
        const [x, y, w, h] = face.box;

        this.ctx.strokeStyle = this.colors.orange;
        this.ctx.setLineDash([5, 5]); // 优雅的虚线增加设计感

        // 绘制圆角矩形
        this.roundRect(x, y, w, h, 12);
        this.ctx.stroke();
        this.ctx.setLineDash([]); // 还原
    }

    private drawWelcomeLabel(face: any) {
        const [x, y, w] = face.box;
        const labelX = x + w + 10;
        const labelY = y + 20;
        const padding = 12;
        const text = `Welcome, ${face.label}`;

        this.ctx.font = "600 14px 'Jost', sans-serif";
        const textWidth = this.ctx.measureText(text).width;

        // 绘制滑出的标签背景 (中世纪现代几何风格)
        this.ctx.fillStyle = this.colors.offWhite;
        this.ctx.shadowColor = "rgba(0,0,0,0.1)";
        this.ctx.shadowBlur = 10;

        this.roundRect(labelX, labelY - 20, textWidth + padding * 2, 36, 18);
        this.ctx.fill();
        this.ctx.shadowBlur = 0;

        // 装饰性小圆点
        this.ctx.fillStyle = this.colors.walnut;
        this.ctx.beginPath();
        this.ctx.arc(labelX + 12, labelY - 2, 4, 0, Math.PI * 2);
        this.ctx.fill();

        // 绘制文字
        this.ctx.fillStyle = this.colors.walnut;
        this.ctx.fillText(text, labelX + 24, labelY + 4);
    }

    private drawGestures(gestures: any[]) {
        const translationMap: Record<string, string> = {
            // 头部方向 (Facing)
            "facing left": "头部：左转",
            "facing right": "头部：右转",
            "facing center": "头部：正向",
            "head up": "头部：向上",
            "head down": "头部：向下",
            
            // 视线方向 (Gaze / Looking)
            "gaze left": "视线：向左",
            "gaze right": "视线：向右",
            "gaze up": "视线：向上",
            "gaze down": "视线：向下",
            "gaze center": "视线：正前",
            "looking left": "眼神：向左",
            "looking right": "眼神：向右",
            "looking up": "眼神：向上",
            "looking down": "眼神：向下",
            "looking center": "眼神：正前",

            // 面部动作
            "mouth open": "状态：张嘴",
            "smile": "表情：微笑",
            "blink left": "动作：左眼闭眼",
            "blink right": "动作：右眼闭眼",

            // 手势识别
            "fist": "手势：握拳",
            "palm": "手势：手掌",
            "open palm": "手势：张开手掌",
            "thumbs up": "手势：点赞",
            "thumbs down": "手势：差评",
            "victory": "手势：胜利 (V)",
            "ok": "手势：OK",
            "stop": "手势：停止",
            "point": "手势：指向",

            // 手指细节 (Finger Forward/Up)
            "index forward": "食指：向前",
            "middle forward": "中指：向前",
            "ring forward": "无名指：向前",
            "pinky forward": "小指：向前",
            "thumb forward": "拇指：向前",
            "index up": "食指：向上",
            "middle up": "中指：向上",
            "ring up": "无名指：向上",
            "pinky up": "小指：向上",
            "thumb up": "拇指：向上"
        };

        const emotionMap: Record<string, string> = {
            "angry": "愤怒", "disgust": "厌恶", "fear": "恐惧", 
            "happy": "开心", "sad": "难过", "surprise": "惊讶", "neutral": "平静"
        };

        gestures.forEach((g, i) => {
            let translated = translationMap[g.gesture];
            
            // 处理动态字符串 (如: mouth 20% open)
            if (!translated) {
                if (g.gesture.includes("mouth") && g.gesture.includes("open")) {
                    const percent = g.gesture.match(/\d+/);
                    translated = percent ? `嘴部：张开 ${percent}%` : "状态：张嘴";
                } else if (g.gesture.startsWith("blink")) {
                    const eye = g.gesture.includes("right") ? "右眼" : "左眼";
                    translated = `动作：${eye}闭眼`;
                } else if (g.gesture.startsWith("palm")) {
                    const dirMap: Record<string, string> = {
                        "up": "向上", "down": "向下", "forward": "向前", 
                        "back": "向后", "left": "向左", "right": "向右"
                    };
                    const dir = Object.keys(dirMap).find(d => g.gesture.includes(d));
                    translated = `手掌：${dir ? dirMap[dir] : g.gesture}`;
                } else if (emotionMap[g.gesture]) {
                    translated = `情绪：${emotionMap[g.gesture]}`;
                } else {
                    translated = `指令: ${g.gesture}`;
                }
            }
            
            // 绘制带有 MCM 风格的背景小标签
            this.ctx.fillStyle = "rgba(245, 245, 245, 0.8)";
            const textWidth = this.ctx.measureText(translated).width;
            this.roundRect(20, 25 + i * 30, textWidth + 20, 24, 12);
            this.ctx.fill();

            this.ctx.fillStyle = this.colors.walnut;
            this.ctx.font = "600 13px 'Jost', sans-serif";
            this.ctx.fillText(translated, 30, 42 + i * 30);
        });
    }

    /**
     * 辅助函数：绘制圆角矩形
     */
    private roundRect(x: number, y: number, w: number, h: number, r: number) {
        if (w < 2 * r) r = w / 2;
        if (h < 2 * r) r = h / 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.arcTo(x + w, y, x + w, y + h, r);
        this.ctx.arcTo(x + w, y + h, x, y + h, r);
        this.ctx.arcTo(x, y + h, x, y, r);
        this.ctx.arcTo(x, y, x + w, y, r);
        this.ctx.closePath();
    }
}
