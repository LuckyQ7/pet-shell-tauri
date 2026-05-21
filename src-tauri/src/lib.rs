use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
struct PetManifest {
    id: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    #[serde(rename = "spritesheetPath")]
    spritesheet_path: String,
}

#[derive(Debug, Serialize)]
struct InstalledPet {
    id: String,
    display_name: String,
    description: Option<String>,
    root_path: String,
    pet_json_path: String,
    spritesheet_path: String,
}

fn pets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("pets"))
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

fn read_pet_manifest(pet_json_path: &Path) -> Result<PetManifest, String> {
    let content = fs::read_to_string(pet_json_path)
        .map_err(|error| format!("无法读取 pet.json: {error}"))?;

    serde_json::from_str(&content).map_err(|error| format!("pet.json 格式不正确: {error}"))
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("无法创建目标目录: {error}"))?;

    for entry in fs::read_dir(from).map_err(|error| format!("无法读取资源包目录: {error}"))? {
        let entry = entry.map_err(|error| format!("无法读取目录项: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取文件类型: {error}"))?;
        let source = entry.path();
        let target = to.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&source, &target)?;
        } else if file_type.is_file() {
            fs::copy(&source, &target).map_err(|error| {
                format!(
                    "复制文件失败 {} -> {}: {error}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }

    Ok(())
}

fn installed_pet_from_dir(dir: PathBuf) -> Result<InstalledPet, String> {
    let pet_json_path = dir.join("pet.json");
    let manifest = read_pet_manifest(&pet_json_path)?;
    let spritesheet_path = dir.join(&manifest.spritesheet_path);

    if !spritesheet_path.is_file() {
        return Err(format!(
            "缺少 spritesheet 文件: {}",
            spritesheet_path.display()
        ));
    }

    Ok(InstalledPet {
        display_name: manifest
            .display_name
            .clone()
            .unwrap_or_else(|| manifest.id.clone()),
        id: manifest.id,
        description: manifest.description,
        root_path: dir.to_string_lossy().into_owned(),
        pet_json_path: pet_json_path.to_string_lossy().into_owned(),
        spritesheet_path: spritesheet_path.to_string_lossy().into_owned(),
    })
}

fn package_dir_name(manifest: &PetManifest) -> String {
    manifest
        .display_name
        .as_deref()
        .unwrap_or(&manifest.id)
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

fn unique_target_dir(root: &Path, manifest: &PetManifest) -> PathBuf {
    let base_name = {
        let name = package_dir_name(manifest);

        if name.is_empty() {
            manifest.id.clone()
        } else {
            name
        }
    };
    let mut target_dir = root.join(&base_name);

    if !target_dir.exists() {
        return target_dir;
    }

    for index in 2.. {
        target_dir = root.join(format!("{base_name}-{index}"));

        if !target_dir.exists() {
            return target_dir;
        }
    }

    unreachable!("unique target directory search should always return")
}

#[tauri::command]
fn install_pet_package(app: AppHandle, package_dir: String) -> Result<InstalledPet, String> {
    let source_dir = PathBuf::from(package_dir);
    let source_manifest_path = source_dir.join("pet.json");

    if !source_dir.is_dir() {
        return Err("请选择一个宠物资源包目录。".to_string());
    }

    let manifest = read_pet_manifest(&source_manifest_path)?;
    let source_spritesheet = source_dir.join(&manifest.spritesheet_path);

    if !source_spritesheet.is_file() {
        return Err(format!(
            "资源包缺少 spritesheet 文件: {}",
            source_spritesheet.display()
        ));
    }

    let root = pets_dir(&app)?;
    let target_dir = unique_target_dir(&root, &manifest);

    copy_dir_all(&source_dir, &target_dir)?;
    installed_pet_from_dir(target_dir)
}

#[tauri::command]
fn list_installed_pets(app: AppHandle) -> Result<Vec<InstalledPet>, String> {
    let root = pets_dir(&app)?;

    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut pets = Vec::new();

    for entry in fs::read_dir(root).map_err(|error| format!("无法读取宠物目录: {error}"))? {
        let entry = entry.map_err(|error| format!("无法读取宠物目录项: {error}"))?;
        let path = entry.path();

        if path.is_dir() {
            match installed_pet_from_dir(path) {
                Ok(pet) => pets.push(pet),
                Err(error) => eprintln!("跳过无效宠物资源包: {error}"),
            }
        }
    }

    pets.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    Ok(pets)
}

pub fn run() {
    // Rust 侧保持很薄：窗口能力主要来自 tauri.conf.json，动画播放交给前端 canvas。
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            install_pet_package,
            list_installed_pets
        ])
        // 目录选择窗口用于安装新的宠物资源包。
        .plugin(tauri_plugin_dialog::init())
        // 保留 opener 插件，后续如果要从菜单打开资源目录或外部链接可以直接用。
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running pet shell");
}
