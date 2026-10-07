# hkt_true — HoloHand STL Viewer

웹캠 손 인식으로 **Turret**, **hailo Modern**, **hailo Legacy** 어셈블리를 분해 · 회전 · 확대/축소하고, 부품을 하나씩 집어서 옮기거나 돌려 볼 수 있는 웹앱입니다.
[HoloHand-Gesture-Agent-3D](https://github.com/tubakhxn/HoloHand-Gesture-Agent-3D)(MIT)의 손 인식 · 제스처 엔진을 그대로 쓰고, 렌더러를 STL 메시용으로 새로 만들었습니다.

모든 처리는 브라우저 안에서 합니다(MediaPipe Hand Landmarker + Three.js). 서버나 API 키가 필요 없고, 카메라 영상도 밖으로 나가지 않습니다.

## 실행 방법 (3가지)

### 1. 파일 하나로 바로 실행 — 설치 없음

[`release/HoloHand-STL.html`](release/HoloHand-STL.html) (14 MB) 하나만 받아서 **더블클릭**하면 Chrome / Edge에서 바로 열립니다.
코드와 세 모델이 전부 이 파일 안에 들어 있습니다.

- 마우스 조작은 오프라인에서도 됩니다.
- 손 인식은 처음 켤 때 MediaPipe 엔진과 손 모델(약 20 MB)을 인터넷(jsDelivr / unpkg, Google)에서 받습니다.
- 다시 만들기: `npm run build:single`

### 2. 웹사이트로 올리기

```bash
npm install
npm run build        # dist/ 폴더 (37 MB, 손 인식 엔진까지 포함 → 인터넷 없이도 손 인식)
```

`dist/` 폴더를 아무 웹 서버(https)에 그대로 올리면 됩니다. 상대 경로로 빌드되어 하위 경로(`/hkt_true/` 등)에서도 동작합니다.

**GitHub Pages** 로 자동 배포하려면, 저장소 **Settings → Pages → Source** 를 **GitHub Actions** 로 한 번 바꿔 두세요.
그러면 `main` 에 push 할 때마다 `.github/workflows/pages.yml` 이 빌드해서 `https://<계정>.github.io/<저장소>/` 에 올립니다.
(Actions 탭에서 **Run workflow** 로 직접 돌릴 수도 있습니다.) 카메라는 https 에서만 동작하는데, GitHub Pages 는 https 입니다.

### 3. 개발 모드

Node.js 18+ 가 필요합니다.

```bash
npm install
npm run dev
```

Vite가 띄워 주는 주소(보통 http://localhost:5173)에서 **카메라 시작**을 누르세요.

## 모델과 좌표

| 모델 | 원본 | 부품 | 원본 삼각형 | 뷰어용 삼각형 |
|---|---|---|---|---|
| Turret | `Turret/Turret/*.stl` | 17 | 약 965만 | 약 42만 |
| hailo Modern | `hailo/hailo/Modern_*.stl` | 11 | 약 655만 | 약 38만 |
| hailo Legacy | `hailo/hailo/Legacy_*.stl` | 9 | 약 719만 | 약 34만 |

원본 STL(약 1.1 GB)은 브라우저에서 바로 쓰기엔 너무 무거워서, `tools/build_models.py` 로 폴리곤을 줄이고 모델마다 파일 하나로 묶어
`web/models/<모델>.bin` + `.json` 으로 둡니다(세 모델 합계 10 MB). 꼭짓점은 부품 바운딩 박스 안의 16비트 정수로 저장해서, 저장 오차가 0.003 mm 이하입니다.

- **좌표 변환 없음.** 꼭짓점은 원본 어셈블리 좌표(mm, Z 위)에 그대로 남습니다. 뷰어는 어셈블리 전체를 한 번만 화면 가운데로 옮기므로, 부품 사이의 상대 위치는 원본과 같습니다.
- **스크립트가 직접 검증합니다.** 뷰어가 실제로 그리는 값(16비트에서 복원한 꼭짓점)을 원본과 비교해, 바운딩 박스 · 중심이 0.5 mm 넘게 어긋나면 실패로 멈춥니다. 현재 최대 오차는 0.12 mm(L-01 다리), 표면 편차 99%값은 0.31 mm 이하입니다.
- **원본은 그대로 둡니다.** `Turret/`, `hailo/` 원본 파일은 수정하지 않고, 앱 번들에도 들어가지 않습니다.
- **hailo는 두 모델로 나눕니다.** 폴더 안에 Legacy(x ≈ -200)와 Modern(x ≈ +200) 두 조립체가 나란히 있어서 따로 보여 줍니다.

### STL을 바꿨을 때

```bash
pip install -r tools/requirements.txt
python3 tools/build_models.py          # web/models 다시 만들기 (2~3분)
npm run build:single                   # 한 파일 버전도 다시 만들기
```

### 분해 방향 바꾸기

분해 시 각 부품이 움직이는 거리는 `tools/explode.json` 에 mm 단위로 들어 있습니다. 부품마다 바운딩 박스를 보고, 쌓인 순서대로 서로 겹치지 않게 정했습니다.
수정한 뒤에는 아래 명령만 실행하면 됩니다. 꽉 분해했을 때 바운딩 박스가 겹치는 부품이 있으면 함께 알려 줍니다.

```bash
python3 tools/build_models.py --manifest-only
```

## 화면과 전개 방식

- **홀로그램 모드** (기본, 툴바의 지구본 버튼): 부품이 청록색 반투명 홀로그램으로 보이고, 모델 둘레로 HUD 링이 돕니다. 선택한 부품은 주황색으로 표시됩니다. 다시 누르면 솔리드(CAD) 모드로 바뀝니다.
- **배경 흐림** (기본, 툴바의 손 버튼): 카메라 배경은 흐리고 어둡게, 손만 선명하게 보여 줍니다.
- **전개: 구형** (기본): 각 부품이 어셈블리 중심에서 바깥쪽으로, **중심과의 유클리드 거리에 비례해서** 이동합니다(100%일 때 거리 × 1.4).
  중심에서 먼 부품일수록 멀리 날아가서 구가 팽창하듯 펼쳐지고, 펼쳐지는 동안 부품을 감싸는 와이어프레임 구가 함께 커집니다.
- **전개: 정렬**: `tools/explode.json` 에 맞춰 둔 이동량으로, 부품이 서로 겹치지 않게 펼칩니다.

## 손 감도

패널의 **손 감도** 슬라이더(20~150 %, 기본 35 %)로 조절하고, 설정은 브라우저에 저장됩니다. 손이 반응하는 규칙은 다음과 같습니다.

- **반쯤 쥔 손·편하게 든 손은 무시합니다.** 손바닥을 완전히 편 손(회전·분해)과 주먹(조립)만 동작합니다.
- **분해는 손을 멈춘 상태에서만 바뀝니다.** 손을 움직여 회전하는 동안에는 분해 정도가 그대로 유지됩니다.
- **화면에 손이 막 들어온 직후는 무시합니다.** 처음 0.4초(최소 8 프레임) 동안은 손 인식이 흔들리기 때문입니다.
- **느린 흔들림은 걸러 냅니다.** 손바닥 속도가 일정 값(35 %에서 약 110 px/s)보다 느리면 회전하지 않습니다. 이 기준은 화면 갱신 속도와 관계없이 같습니다.
- **손목 비틀기는 여러 프레임 평균으로 판단합니다.** 손떨림은 상쇄되고 의도한 비틀기만 반영됩니다.

합성한 손 입력으로 측정한 결과(같은 동작, 30 fps 기준)입니다.

| | 55 % | 35 % (기본) |
|---|---|---|
| 반쯤 쥔 손을 움직임 | 0° | 0° |
| 편 손을 가만히 들었을 때의 떨림(약 3 px) | 0° | 0° |
| 편 손을 화면 폭의 15 %만큼 빠르게 이동 | 13° 회전 | 8° 회전 |
| 손목 60° 비틀기 | 26° 회전 | 16° 회전 |

## 부품 설명

부품을 검지로 가리키거나, 마우스를 올리거나, 클릭하면 부품 옆에 설명 상자가 뜹니다. 상자에는 계열, 부품 번호와 이름, 한글 이름, 설명이 들어갑니다.
패널의 부품 카드에도 같은 내용이 나오고, 부품 목록은 계열별로 묶여 있습니다.
Turret은 B 베이스 / Y 회전축 / H 센서·시연 장치 / L 지지구조, HaloPod는 공통 Pod / Legacy 전용 / Modern 전용으로 나뉩니다.

설명을 바꾸려면 `tools/parts_info.json` 을 고친 뒤 `python3 tools/build_models.py --manifest-only` 를 실행하세요.

## 제스처
## 마우스 · 키보드

드래그 = 회전 · 휠 = 확대 · 클릭 = 부품 선택 · **Shift+드래그** = 부품 이동 · **Alt(또는 Ctrl)+드래그** = 부품 회전

`Space` 분해/조립 · `←` `→` / `1`–`3` 모델 전환 · `R` 시점 초기화 · `P` 부품 원위치 · `X` X-ray · `I` 선택 부품만 보기 · `H` 선택 부품 숨기기 · `E` 모서리 선 · `Esc` 선택 해제

다른 STL 폴더는 **📂 폴더 열기** 또는 화면에 끌어다 놓기로 바로 볼 수 있습니다(저장소에는 추가되지 않음).

## 파일

```
Turret/, hailo/          원본 STL (수정하지 않음)
release/HoloHand-STL.html  더블클릭으로 실행하는 한 파일 버전 (npm run build:single 이 생성)
web/models/<모델>.bin/.json  뷰어용 경량 모델 (tools/build_models.py 가 생성)
.github/workflows/pages.yml  GitHub Pages 자동 배포
tools/build_models.py    폴리곤 축소 · 16비트 패킹 · 좌표 검증
tools/explode.json       부품별 분해 이동량 (mm)
tools/parts_info.json    부품 이름 · 계열 · 설명
src/main.js              앱 루프, 손 오버레이, 제스처 → 동작, 이름표, UI
src/scene.js             Three.js STL 렌더러: 분해, 부품 이동/회전, 선택(BVH 레이캐스트), X-ray, 단독 보기
src/library.js           web/models 자동 탐색, 폴더 열기 / 드래그 앤 드롭 (STL + parts.json)
src/handTracking.js      MediaPipe 래퍼 (HoloHand 그대로)
src/gestureEngine.js     랜드마크 → 제스처 · 손 펴짐 · 손목 회전 (HoloHand 그대로)
scripts/setup.mjs        npm install 시 MediaPipe WASM 복사 + 손 모델 다운로드 (실패하면 실행 시 CDN 사용)
scripts/finish-single.mjs  한 파일 빌드 마무리 (release/HoloHand-STL.html)
```

HoloHand 원본 라이선스는 `LICENSE-HoloHand` 에 있습니다.
