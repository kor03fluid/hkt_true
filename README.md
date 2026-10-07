# hkt_true — HoloHand STL Viewer

웹캠 손 인식으로 **Turret**, **hailo Modern**, **hailo Legacy** 어셈블리를 분해 · 회전 · 확대/축소하고, 부품을 하나씩 집어서 옮기거나 돌려 볼 수 있는 웹앱입니다.
[HoloHand-Gesture-Agent-3D](https://github.com/tubakhxn/HoloHand-Gesture-Agent-3D)(MIT)의 손 인식 · 제스처 엔진을 그대로 쓰고, 렌더러를 STL 메시용으로 새로 만들었습니다.

모든 처리는 브라우저 안에서 합니다(MediaPipe Hand Landmarker + Three.js). 서버나 API 키가 필요 없고, 카메라 영상도 밖으로 나가지 않습니다.

## 실행

Node.js 18+ 와 Chrome / Edge 가 필요합니다.

```bash
npm install
npm run dev
```

Vite가 띄워 주는 주소(보통 http://localhost:5173)에서 **카메라 시작**을 누르세요. 카메라는 `http://localhost` 또는 `https` 에서만 동작합니다.

## 모델과 좌표

| 모델 | 원본 | 부품 | 원본 삼각형 | 뷰어용 삼각형 |
|---|---|---|---|---|
| Turret | `Turret/Turret/*.stl` | 17 | 약 965만 | 약 42만 |
| hailo Modern | `hailo/hailo/Modern_*.stl` | 11 | 약 655만 | 약 38만 |
| hailo Legacy | `hailo/hailo/Legacy_*.stl` | 9 | 약 719만 | 약 34만 |

원본 STL(약 1.1 GB)은 브라우저에서 바로 쓰기엔 너무 무거워서, `tools/build_models.py` 로 부품마다 가벼운 사본을 만들어 `web/models/` 에 둡니다(합계 55 MB).

- **좌표 변환 없음.** 꼭짓점은 원본 어셈블리 좌표(mm, Z 위)에 그대로 남습니다. 뷰어는 어셈블리 전체를 한 번만 화면 가운데로 옮기므로, 부품 사이의 상대 위치는 원본과 같습니다.
- **스크립트가 직접 검증합니다.** 부품마다 원본과 비교해 바운딩 박스 · 중심이 0.5 mm 넘게 어긋나면 실패로 멈춥니다. 현재 최대 오차는 0.12 mm(L-01 다리), 표면 편차 99%값은 0.31 mm 이하입니다.
- **원본은 그대로 둡니다.** `Turret/`, `hailo/` 원본 파일은 수정하지 않고, 앱 번들에도 들어가지 않습니다.
- **hailo는 두 모델로 나눕니다.** 폴더 안에 Legacy(x ≈ -200)와 Modern(x ≈ +200) 두 조립체가 나란히 있어서 따로 보여 줍니다.

### STL을 바꿨을 때

```bash
pip install -r tools/requirements.txt
python3 tools/build_models.py          # 경량 STL + parts.json 다시 만들기 (2~3분)
```

### 분해 방향 바꾸기

분해 시 각 부품이 움직이는 거리는 `tools/explode.json` 에 mm 단위로 들어 있습니다. 부품마다 바운딩 박스를 보고, 쌓인 순서대로 서로 겹치지 않게 정했습니다.
수정한 뒤에는 아래 명령만 실행하면 됩니다. 꽉 분해했을 때 바운딩 박스가 겹치는 부품이 있으면 함께 알려 줍니다.

```bash
python3 tools/build_models.py --manifest-only
```

## 제스처

| 제스처 | 동작 |
|---|---|
| 손 천천히 펴기 | 분해 (손바닥 링의 흰 호 = 분해 정도) |
| 주먹 | 조립. 0.6초 이상 쥐고 있으면 옮긴 부품도 원위치 |
| 손 이동 · 비틀기 | 모델 회전 · 기울이기 |
| 검지로 가리키기 | 손끝 아래 부품 강조, 0.7초 멈추면 선택 |
| 집기(핀치) | 부품을 잡아 끌어서 이동, 집은 채로 손목을 비틀면 부품 회전. 놓은 자리에 그대로 둠 |
| 양손 벌리기 / 모으기 | 확대 / 축소 |
| 브이(약 0.3초 유지) | 다음 모델 |

패널의 **손으로 분해** 버튼을 끄면, 손을 펴도 분해되지 않고 회전만 합니다.

## 마우스 · 키보드

드래그 = 회전 · 휠 = 확대 · 클릭 = 부품 선택 · **Shift+드래그** = 부품 이동 · **Alt(또는 Ctrl)+드래그** = 부품 회전

`Space` 분해/조립 · `←` `→` / `1`–`3` 모델 전환 · `R` 시점 초기화 · `P` 부품 원위치 · `X` X-ray · `I` 선택 부품만 보기 · `H` 선택 부품 숨기기 · `E` 모서리 선 · `Esc` 선택 해제

다른 STL 폴더는 **📂 폴더 열기** 또는 화면에 끌어다 놓기로 바로 볼 수 있습니다(저장소에는 추가되지 않음).

## 파일

```
Turret/, hailo/          원본 STL (수정하지 않음)
web/models/<모델>/       뷰어용 경량 STL + parts.json (tools/build_models.py 가 생성)
tools/build_models.py    폴리곤 축소 · 좌표 검증 · parts.json 생성
tools/explode.json       부품별 분해 이동량 (mm)
src/main.js              앱 루프, 손 오버레이, 제스처 → 동작, 이름표, UI
src/scene.js             Three.js STL 렌더러: 분해, 부품 이동/회전, 선택(BVH 레이캐스트), X-ray, 단독 보기
src/library.js           web/models 자동 탐색, parts.json, 폴더 열기 / 드래그 앤 드롭
src/handTracking.js      MediaPipe 래퍼 (HoloHand 그대로)
src/gestureEngine.js     랜드마크 → 제스처 · 손 펴짐 · 손목 회전 (HoloHand 그대로)
scripts/setup.mjs        npm install 시 MediaPipe WASM 복사 + 손 모델 다운로드 (실패하면 실행 시 CDN 사용)
```

HoloHand 원본 라이선스는 `LICENSE-HoloHand` 에 있습니다.
