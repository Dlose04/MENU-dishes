# 预置菜的照片源文件

这里放着自家那 8 道菜的原图。构建产物里的照片**不读这个目录** —— 它读的是
`src/db/seed-photos.ts`（由 `npm run seed-photos` 从这里的 `dish-N.jpg` 生成）。
这个目录是「底片」，留着是为了以后想重压、重新裁的时候还有得改。

两组文件：

| 文件 | 是什么 | 用不用 |
| --- | --- | --- |
| `dish-1..8.jpg` | 处理过的成品：最长边 720px、质量 72、EXIF 方向已转正 | **生成脚本读这组** |
| `raw-1..8.jpeg` | 手机里导出来的原始照片，三五 MB 一张 | 不用，只是留档 |

序号 → 菜名的对应关系写在 `scripts/make-seed-photos.mjs` 的 `ORDER` 里，
必须和 `src/db/seed.ts` 的 `PRESET_RECIPES` 顺序一致。

要换照片：

```bash
# 1. 把新照片处理成 dish-N.jpg（见 scripts/make-seed-photos.mjs 顶部的 Pillow 片段）
# 2. 重新生成内联的那份
npm run seed-photos
```

注意 `exif_transpose` 那一步别省 —— 手机竖着拍的照片方向记在 EXIF 里，
不转正的话在应用里会躺着。
