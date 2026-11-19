"""畫 App 圖示：藍底白色播放三角形（通用符號，不含任何文字或品牌）。產出 icons/icon-180/192/512.png。"""
import os
from PIL import Image, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(HERE, 'icons'), exist_ok=True)
for s in (180, 192, 512):
    k = 4; S = s * k
    im = Image.new('RGB', (S, S), (47, 93, 154))           # 滿版不透明：iOS 自己會切圓角
    d = ImageDraw.Draw(im)
    r = S * 0.30                                            # 白色圓
    cx = cy = S / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255))
    t = r * 0.55                                            # 藍色三角形（略往右補視覺重心）
    ox = r * 0.12
    d.polygon([(cx - t * 0.5 + ox, cy - t * 0.87), (cx - t * 0.5 + ox, cy + t * 0.87), (cx + t + ox, cy)], fill=(47, 93, 154))
    im.resize((s, s), Image.LANCZOS).save(os.path.join(HERE, 'icons', f'icon-{s}.png'))
print('ok')
