# メインスクリーン（スコアボード）デザイン・実装指示書

本ドキュメントは、クイズ大会用アプリの「メインスクリーン（プロジェクター表示用）」のデザインおよびCSS/HTML構造の仕様書です。
Excelで作られた従来の競技クイズ用得点表示画面の見た目を再現し、WEBブラウザ上で動作するスコアボードを構築します。

---

## 1. 全体レイアウト構成 (16:9 フルスクリーン)

画面全体は黒（#000000）背景とし、画面上部に「ルールヘッダー」、中央〜下部に「プレイヤーネームプレート＆スコア列」を横並びで配置します。

---

## 2. カラーパレット & タイポグラフィ

### カラー仕様
* **全体背景色:** `#000000` (純黒)
* **テキスト基本色:** `#FFFFFF` (白)
* **ポイント数・強調文字:** `#FFFFFF` または `#FFFF00` (黄色)
* **ネームプレート背景色（ランダムまたはプレイヤー指定）:**
  * 赤系: `#CC0000`
  * 青系: `#0044CC`
  * 黒/ダークグレー系: `#222222`
  * 緑系: `#008833`
* **状態バッジ背景色:**
  * 勝ち抜け (1st, 2nd...): `#D4AF37` (ゴールド) または `#E67E22` (オレンジ)
  * お休み / 休み状態: `#7F8C8D` (グレー)
  * 失格 (LOSE): `#8B0000` (ダークレッド)

### タイポグラフィ
* **フォントファミリー:** `sans-serif` (ゴシック体、太字推奨。`Impact`, `Arial Black`, `Hiragino Sans`, `Meiryo` 等)
* **ネームプレートテキスト:** 縦書き設定 (`writing-mode: vertical-rl`)

---

## 3. 各コンポーネント詳細仕様

### (1) プレイヤーカード (列要素)
各プレイヤーは垂直方向のカード（列）として表示し、`flexbox` または `grid` で横並びに配置します。

* **幅・高さ:** 画面の横幅に応じて自動伸縮 (`flex: 1`, `max-width: 120px` 程度)
* **ネームプレート部分 (Nameplate):**
  * 高さを十分にとり、`writing-mode: vertical-rl` で名前を縦書きで中央揃え表示。
  * 苗字と名前の間、または複数文字の視認性を保持。
* **状態バッジ (Status Badge):**
  * ネームプレートの真上に配置。
  * 勝ち抜け時は「1st」「2nd」、失格時は「LOSE」を表示。
* **スコア表示 (Score):**
  * ネームプレートの下に配置。
  * 正解数（ポイント）を巨大な数字（`font-size: 2.5rem` 以上）で表示。
* **誤答/ペナルティカウンター (Penalty):**
  * 最下部に配置。
  * `O`（正解マーク）や `X`（誤答マーク）をカウント分だけ並べて表示、または数字で「1」「2」などと表示。

---

## 4. CSS 実装コード例 (参考)

```css
/* ベース設定 */
body {
  background-color: #000000;
  color: #ffffff;
  font-family: "Helvetica Neue", Arial, "メイリオ", sans-serif;
  margin: 0;
  padding: 20px;
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

/* スコアボードコンテナ */
.scoreboard-container {
  display: flex;
  justify-content: center;
  align-items: stretch;
  gap: 8px;
  flex: 1;
  width: 100%;
}

/* プレイヤー列 */
.player-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  max-width: 100px;
  background-color: #111111;
  border-radius: 4px;
  overflow: hidden;
}

/* 状態バッジ */
.status-badge {
  width: 100%;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 0.9rem;
  background-color: transparent;
}
.status-badge.rank-1st { background-color: #d4af37; color: #000; }
.status-badge.lose { background-color: #8b0000; color: #fff; }

/* 縦書きネームプレート */
.nameplate {
  writing-mode: vertical-rl;
  text-orientation: upright;
  flex: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  font-weight: bold;
  letter-spacing: 4px;
  padding: 10px 0;
  background-color: #222222; /* デフォルト背景 */
}

/* スコア数表示 */
.score-display {
  width: 100%;
  padding: 10px 0;
  text-align: center;
  font-size: 2.5rem;
  font-weight: bold;
  background-color: #000000;
  color: #ffffff;
}

/* 誤答カウンター */
.penalty-display {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  color: #ff4444;
  background-color: #111111;
}