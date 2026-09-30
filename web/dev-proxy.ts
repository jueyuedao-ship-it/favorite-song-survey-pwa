export function apiDevProxy(target = "http://127.0.0.1:8791") {
  return {
    "^/api/v1(?:/|$)": { target, changeOrigin: false },
  };
}
