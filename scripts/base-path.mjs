/**
 * 计算部署基路径。vite.config.ts 与 postbuild.mjs 共用这一份逻辑。
 *
 * 为什么要专门抽出来：两边各算一次，出现分歧时
 * SW 缓存的路径会和实际资源路径错开，离线直接失效，而且很难查。
 */

export function resolveBase(raw) {
  let s = (raw || '/').trim();
  if (!s) return '/';

  // Windows 绝对路径与盘符一律拒绝。
  // Git Bash 会把命令行里的 /my-plants/ 转成 D:/.../my-plants/，
  // 那是 MSYS 的路径转换，不是我们想要的部署前缀。
  if (/^[a-zA-Z]:[\/]/.test(s) || s.startsWith('\\')) {
    throw new Error(
      'BASE_PATH 看起来是本机路径而不是部署前缀：' + s +
      '。Git Bash 会把 /xxx/ 转成 Windows 路径，请改用 .env.pages 文件或 CI 环境变量传值。',
    );
  }

  const trimmed = s.replace(/^\/+|\/+$/g, '');
  return trimmed ? '/' + trimmed + '/' : '/';
}

/** 统一的读取顺序：环境变量优先，其次 env 文件 */
export function pickBase(env) {
  return resolveBase(env.BASE_PATH);
}
