# `@h5cs/config`

共享的 TypeScript 与 ESLint Flat Config。包中只包含构建期配置，不读取环境变量，也不得承载应用 Secret。

Node 应用的 `tsconfig.json`：

```json
{
  "extends": "@h5cs/config/tsconfig/node.json",
  "include": ["src/**/*.ts"]
}
```

Next.js 应用的 `tsconfig.json`：

```json
{
  "extends": "@h5cs/config/tsconfig/nextjs.json",
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]
}
```

Node/通用包的 `eslint.config.mjs`：

```js
import config from '@h5cs/config/eslint/base';

export default config;
```

Next.js 应用改为导入 `@h5cs/config/eslint/next`。消费工作区仍应显式声明 ESLint、TypeScript 以及所需的 Next peer dependency；版本由根 catalog 统一。
