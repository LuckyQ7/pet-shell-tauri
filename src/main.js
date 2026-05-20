import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";

// 默认内置宠物。安装外部资源包后，会切到应用数据目录里的资源。
const BUILTIN_PET = {
  id: "taro",
  displayName: "Taro",
  rootPath: "/pets/taro",
  source: "builtin"
};

// Codex 宠物图集的标准单格尺寸：8 列 x 9 行，每个状态占一行。
const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;

// Canvas 内部保持原始像素尺寸，CSS 放大显示，这样切帧坐标不会被缩放逻辑影响。
const DEFAULT_DISPLAY_SCALE = 1.15;
const DEFAULT_SPEED = 0.7;
const DEFAULT_FPS = 6;
const TRANSITION_MS = 180;
const WINDOW_PADDING_X = 28;
const WINDOW_PADDING_Y = 32;
const MIN_DISPLAY_SCALE = 0.75;
const MAX_DISPLAY_SCALE = 1.8;

// 每一项对应图集里的一行。row 是从 0 开始的行号，frames 是该状态实际使用的帧数。
const STATES = [
  { id: "idle", label: "待机", row: 0, frames: 6, fps: 5 },
  { id: "running-right", label: "向右", row: 1, frames: 8, fps: 7 },
  { id: "running-left", label: "向左", row: 2, frames: 8, fps: 7 },
  { id: "waving", label: "挥手", row: 3, frames: 4, fps: 5 },
  { id: "jumping", label: "跳跃", row: 4, frames: 5, fps: 6 },
  { id: "failed", label: "失败", row: 5, frames: 8, fps: 5 },
  { id: "waiting", label: "等待", row: 6, frames: 6, fps: 5 },
  { id: "running", label: "工作", row: 7, frames: 6, fps: 6 },
  { id: "review", label: "审阅", row: 8, frames: 6, fps: 5 }
];

const SPEED_OPTIONS = [
  { id: "slow", label: "慢", multiplier: 0.55 },
  { id: "normal", label: "标准", multiplier: DEFAULT_SPEED },
  { id: "fast", label: "快", multiplier: 0.9 }
];

const RANDOM_MENU_ITEM = {
  id: "random",
  label: "随机"
};

const canvas = document.querySelector("#pet-canvas");
const context = canvas.getContext("2d");
const resizeHandle = document.querySelector("#resize-handle");
const stateMenu = document.querySelector("#state-menu");
const appWindow = getCurrentWindow();

let currentState = STATES[0];
let frameIndex = 0;
let lastFrameAt = 0;
let animationId = 0;
let petConfig = null;
let spritesheet = null;
let contextMenu = null;
let transition = null;
let activePet = BUILTIN_PET;
let installedPets = [];
let contextMenuReady = false;
let displayScale = DEFAULT_DISPLAY_SCALE;
let speedMultiplier = DEFAULT_SPEED;
let resizeState = null;

applyDisplayScale(displayScale);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateResizeHandle() {
  resizeHandle.title = `拖动调整大小（${Math.round(displayScale * 100)}%）`;
}

async function applyDisplayScale(scale) {
  displayScale = clamp(scale, MIN_DISPLAY_SCALE, MAX_DISPLAY_SCALE);
  canvas.style.width = `${CELL_WIDTH * displayScale}px`;
  canvas.style.height = `${CELL_HEIGHT * displayScale}px`;
  updateResizeHandle();

  await appWindow
    .setSize(
      new LogicalSize(
        Math.ceil(CELL_WIDTH * displayScale + WINDOW_PADDING_X),
        Math.ceil(CELL_HEIGHT * displayScale + WINDOW_PADDING_Y)
      )
    )
    .catch((error) => {
      console.warn("调整窗口大小失败，请检查 core:window:allow-set-size 权限。", error);
    });
}

async function setSpeedMultiplier(multiplier) {
  speedMultiplier = multiplier;
  lastFrameAt = 0;
  await rebuildContextMenu();
}

function resourceUrl(path) {
  if (path.startsWith("/")) {
    return new URL(path, window.location.origin).href;
  }

  return new URL(path, window.location.href).href;
}

function installedPetToOption(pet) {
  return {
    id: pet.id,
    displayName: pet.display_name,
    description: pet.description,
    petJsonPath: pet.pet_json_path,
    rootPath: pet.root_path,
    spritesheetPath: pet.spritesheet_path,
    source: "installed"
  };
}

async function refreshInstalledPets() {
  const pets = await invoke("list_installed_pets");
  installedPets = pets.map(installedPetToOption);
}

async function loadPet(pet = activePet) {
  // pet.json 只保存宠物元信息和图集相对路径，真正的动画帧都在 spritesheet 里。
  const petJsonUrl =
    pet.source === "installed"
      ? `asset://localhost/${pet.petJsonPath}`
      : resourceUrl(`${pet.rootPath}/pet.json`);
  const response = await fetch(petJsonUrl);

  if (!response.ok) {
    throw new Error(`无法读取宠物配置: ${response.status} ${petJsonUrl}`);
  }

  petConfig = await response.json();

  const spritesheetUrl =
    pet.source === "installed"
      ? `asset://localhost/${pet.spritesheetPath}`
      : resourceUrl(`${pet.rootPath}/${petConfig.spritesheetPath}`);
  const nextSpritesheet = new Image();

  nextSpritesheet.src = spritesheetUrl;
  await nextSpritesheet.decode();

  activePet = {
    ...pet,
    displayName: petConfig.displayName ?? pet.displayName ?? pet.id
  };
  spritesheet = nextSpritesheet;
  document.title = `${activePet.displayName} 桌宠`;
}

async function switchPet(pet) {
  const previousState = currentState;
  const previousFrame = frameIndex;

  await loadPet(pet);
  currentState = STATES[0];
  frameIndex = 0;
  lastFrameAt = 0;
  transition = {
    fromState: previousState,
    fromFrame: previousFrame,
    startedAt: performance.now()
  };

  updateStateButtons();
  await rebuildContextMenu();
  drawFrame();
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function easeInCubic(value) {
  return value * value * value;
}

function drawSpriteFrame(state, frame, opacity = 1, scale = 1, translateY = 0) {
  const scaledWidth = CELL_WIDTH * scale;
  const scaledHeight = CELL_HEIGHT * scale;
  const x = (CELL_WIDTH - scaledWidth) / 2;
  const y = (CELL_HEIGHT - scaledHeight) / 2 + translateY;

  context.save();
  context.globalAlpha = opacity;

  // 从整张 spritesheet 中裁出指定状态的指定帧，再绘制到透明 canvas 上。
  context.drawImage(
    spritesheet,
    frame * CELL_WIDTH,
    state.row * CELL_HEIGHT,
    CELL_WIDTH,
    CELL_HEIGHT,
    x,
    y,
    scaledWidth,
    scaledHeight
  );

  context.restore();
}

function drawFrame(timestamp = performance.now()) {
  context.clearRect(0, 0, CELL_WIDTH, CELL_HEIGHT);

  if (!transition) {
    drawSpriteFrame(currentState, frameIndex);
    return;
  }

  const progress = Math.min(1, (timestamp - transition.startedAt) / TRANSITION_MS);
  const exitProgress = easeInCubic(progress);
  const enterProgress = easeOutCubic(progress);

  // 旧状态轻微下沉淡出，新状态轻微放大淡入，比硬切更像一次小小的换姿势。
  drawSpriteFrame(
    transition.fromState,
    transition.fromFrame,
    1 - exitProgress,
    1 - exitProgress * 0.025,
    exitProgress * 5
  );
  drawSpriteFrame(
    currentState,
    frameIndex,
    enterProgress,
    0.96 + enterProgress * 0.04,
    (1 - enterProgress) * -5
  );

  canvas.classList.toggle("is-changing", progress < 1);

  if (progress >= 1) {
    transition = null;
    canvas.classList.remove("is-changing");
  }
}

function tick(timestamp) {
  const frameMs = 1000 / ((currentState.fps ?? DEFAULT_FPS) * speedMultiplier);

  // requestAnimationFrame 跟着屏幕刷新跑，这里用 fps 控制实际切帧速度。
  if (!lastFrameAt || timestamp - lastFrameAt >= frameMs) {
    frameIndex = (frameIndex + 1) % currentState.frames;
    lastFrameAt = timestamp;
  }

  drawFrame(timestamp);
  animationId = requestAnimationFrame(tick);
}

function chooseRandomState() {
  const candidates = STATES.filter((state) => state.id !== currentState.id);
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

function setState(stateId, options = {}) {
  if (stateId === RANDOM_MENU_ITEM.id) {
    const nextRandomState = chooseRandomState();
    setState(nextRandomState.id, { ...options, source: RANDOM_MENU_ITEM.id });
    return;
  }

  const nextState = STATES.find((state) => state.id === stateId);

  if (!nextState || nextState.id === currentState.id) {
    return;
  }

  const previousState = currentState;
  const previousFrame = frameIndex;

  // 切换状态时从第 0 帧重新播放，避免从上一行的帧号跳到新状态中间。
  currentState = nextState;
  frameIndex = 0;
  lastFrameAt = 0;
  transition = options.instant
    ? null
    : {
        fromState: previousState,
        fromFrame: previousFrame,
        startedAt: performance.now()
      };

  updateStateButtons();
  drawFrame();
}

function updateStateButtons() {
  for (const button of stateMenu.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.state === currentState.id);
  }
}

function setupStateMenu() {
  // 悬停菜单和右键菜单共用同一份 STATES 配置，后续新增状态只改一处。
  for (const state of [...STATES, RANDOM_MENU_ITEM]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = state.label;
    button.dataset.state = state.id;
    button.addEventListener("click", () => setState(state.id));
    stateMenu.appendChild(button);
  }

  updateStateButtons();
}

function setupDrag() {
  canvas.addEventListener("pointerdown", async (event) => {
    // 只让左键拖动窗口，右键留给状态菜单。
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();

    // Tauri 提供的原生拖动能力，比自己计算鼠标坐标更稳。
    await appWindow.startDragging().catch((error) => {
      console.warn("窗口拖动失败，请检查 core:window:allow-start-dragging 权限。", error);
    });
  });
}

function setupResizeHandle() {
  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    resizeState = {
      startX: event.screenX,
      startY: event.screenY,
      startScale: displayScale
    };

    resizeHandle.setPointerCapture(event.pointerId);
    document.body.dataset.resizing = "true";
  });

  resizeHandle.addEventListener("pointermove", (event) => {
    if (!resizeState) {
      return;
    }

    const deltaX = event.screenX - resizeState.startX;
    const deltaY = event.screenY - resizeState.startY;
    const dominantDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const nextScale = resizeState.startScale + dominantDelta / 260;

    applyDisplayScale(nextScale);
  });

  resizeHandle.addEventListener("pointerup", async (event) => {
    if (!resizeState) {
      return;
    }

    resizeHandle.releasePointerCapture(event.pointerId);
    resizeState = null;
    delete document.body.dataset.resizing;
    await rebuildContextMenu().catch(showError);
  });

  resizeHandle.addEventListener("pointercancel", (event) => {
    if (resizeState) {
      resizeHandle.releasePointerCapture(event.pointerId);
    }

    resizeState = null;
    delete document.body.dataset.resizing;
  });
}

async function installPetPackage() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择宠物资源包目录"
  });

  if (!selected) {
    return;
  }

  const installedPet = await invoke("install_pet_package", {
    packageDir: selected
  });
  const pet = installedPetToOption(installedPet);

  await refreshInstalledPets();
  await switchPet(pet);
}

async function setupContextMenu() {
  // 右键菜单走系统原生菜单，在 Windows 和 macOS 上都会使用对应平台样式。
  const petItems = installedPets.map((pet) => ({
    id: `pet-${pet.id}`,
    text: pet.id === activePet.id ? `✓ ${pet.displayName}` : pet.displayName,
    action: () => switchPet(pet).catch(showError)
  }));
  const speedItems = SPEED_OPTIONS.map((option) => ({
    id: `speed-${option.id}`,
    text:
      option.multiplier === speedMultiplier
        ? `✓ 速度：${option.label}`
        : `速度：${option.label}`,
    action: () => setSpeedMultiplier(option.multiplier).catch(showError)
  }));
  const items = [
    {
      id: RANDOM_MENU_ITEM.id,
      text: RANDOM_MENU_ITEM.label,
      action: () => setState(RANDOM_MENU_ITEM.id)
    },
    { item: "Separator" },
    ...speedItems,
    { item: "Separator" },
    ...STATES.map((state) => ({
      id: state.id,
      text: state.label,
      action: () => setState(state.id)
    })),
    { item: "Separator" },
    {
      id: "install-pet",
      text: "安装宠物资源包...",
      action: () => installPetPackage().catch(showError)
    },
    ...(petItems.length > 0 ? [{ item: "Separator" }, ...petItems] : []),
    { item: "Separator" },
    {
      id: "quit",
      text: "退出",
      action: () => appWindow.close()
    }
  ];

  const menu = await Menu.new({ items });
  contextMenu = menu;

  if (!contextMenuReady) {
    contextMenuReady = true;

    window.addEventListener("contextmenu", async (event) => {
      event.preventDefault();

      if (contextMenu) {
        await contextMenu.popup();
      }
    });
  }
}

async function rebuildContextMenu() {
  if (contextMenu) {
    await contextMenu.close();
    contextMenu = null;
  }

  await setupContextMenu();
}

function showError(error) {
  console.error(error);
  document.body.dataset.error = "true";
  document.body.dataset.errorMessage = String(error);
}

async function start() {
  // 顺序很轻：先挂交互，再加载资源，资源到位后开始绘制和循环。
  setupStateMenu();
  setupDrag();
  setupResizeHandle();
  await refreshInstalledPets().catch((error) => {
    console.warn("读取已安装宠物失败，继续使用内置宠物。", error);
  });
  await loadPet();

  setupContextMenu().catch((error) => {
    console.warn("右键菜单初始化失败，宠物仍可通过底部按钮切换状态。", error);
  });

  drawFrame(performance.now());
  animationId = requestAnimationFrame(tick);
}

window.addEventListener("beforeunload", () => cancelAnimationFrame(animationId));
start().catch((error) => {
  // 保留一个前端可见的失败态，方便资源路径错了时第一眼看出来。
  showError(error);
});
