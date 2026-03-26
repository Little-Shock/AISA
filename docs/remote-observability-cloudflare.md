# AISA 远程可观测接入

这份说明只覆盖只读观测场景。

目标很简单：

- `control-api` 继续只监听本机
- `dashboard-ui` 继续跑在本机
- 远端设备只访问一个 Cloudflare 入口
- 不直接暴露本机公网 IP

## 推荐结构

推荐把 AISA 跑成下面这条链路：

`Phone / Laptop -> Cloudflare Access -> Cloudflare Tunnel -> dashboard-ui -> /api/control proxy -> control-api`

这样有几个直接好处：

- 手机和别的机器只需要访问 dashboard 域名
- 浏览器不会去请求远端设备自己的 `127.0.0.1`
- `control-api` 不需要单独暴露到公网
- 认证放在 Cloudflare Access 这一层，不放在本机服务里拼

## 仓库里已经做掉的接线

当前 dashboard 已经默认改成同源代理模式：

- 浏览器请求 `/api/control/*`
- Next.js 服务端把请求转发到本机 `control-api`
- 默认上游目标是 `http://127.0.0.1:8787`

这样只要 tunnel 指向 dashboard 端口，就能把 run 观察台带到手机上。

## 本机启动方式

先在 mini 本机启动：

```bash
pnpm --filter @autoresearch/control-api dev
pnpm --filter @autoresearch/dashboard-ui dev
```

默认端口：

- dashboard `http://127.0.0.1:3000`
- control-api `http://127.0.0.1:8787`

如果 dashboard 需要转发到别的 API 地址，可以在启动 dashboard 前设置：

```bash
export CONTROL_API_PROXY_TARGET=http://127.0.0.1:8787
```

## Cloudflare 入口

推荐 tunnel 只指向 dashboard：

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

正式长期使用时，再把这个 tunnel 绑定到固定域名，并在 Cloudflare Access 里把入口限制到你的账号体系。

## 适用范围

这套方案当前适合：

- 只读观察 run 状态
- 从手机看 attempt 契约、结果、日志尾部
- 从别的机器盯自举 run 有没有卡死

这份方案暂时不解决：

- 细粒度多用户权限
- 对外开放写操作
- 长时间公开托管

如果后面要把写操作也开放出去，建议继续沿用同源代理，不要让浏览器直接拿到本机 `control-api` 地址。
