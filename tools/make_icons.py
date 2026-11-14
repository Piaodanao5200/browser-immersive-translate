"""生成扩展图标：蓝色渐变圆角方块 + 白色「译」字"""
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 32, 48, 128]
FONT = "C:/Windows/Fonts/msyhbd.ttc"
OUT = "D:/浏览器翻译插件/icons"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    scale = 8  # 超采样，最后缩小抗锯齿
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 渐变底
    top = (56, 132, 255)
    bottom = (37, 79, 214)
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        gd.line([(0, y), (s, y)], fill=lerp(top, bottom, y / max(1, s - 1)) + (255,))

    # 圆角遮罩
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    radius = int(s * 0.235)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 「译」字
    draw = ImageDraw.Draw(img)
    font_size = int(s * 0.66)
    try:
        font = ImageFont.truetype(FONT, font_size)
    except OSError:
        font = ImageFont.load_default()
    text = "译"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pos = ((s - tw) / 2 - bbox[0], (s - th) / 2 - bbox[1] - s * 0.01)
    draw.text(pos, text, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    make(size).save(f"{OUT}/icon{size}.png")
    print("written", size)
