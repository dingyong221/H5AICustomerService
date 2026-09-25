'use server';

import {
  IndustryTemplateAlreadyExistsError,
  loadDatabaseConfig,
  MySqlIndustryTemplateRepository,
} from '@h5cs/database';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentOperator } from './operator-actions';
import { loadOperatorAuthConfig } from './operator-auth';

export type IndustryTemplateActionState = Readonly<{
  error: string | null;
  created: string | null;
}>;

export async function createIndustryTemplate(
  _previous: IndustryTemplateActionState,
  formData: FormData,
): Promise<IndustryTemplateActionState> {
  const config = loadOperatorAuthConfig();
  const operator = await currentOperator();
  if (!config || !operator) return { error: '运营登录已失效。', created: null };
  if ((await headers()).get('origin') !== config.publicOrigin) {
    return { error: '请求来源校验失败。', created: null };
  }
  const field = (name: string): string | null => {
    const value = formData.get(name);
    return typeof value === 'string' ? value : null;
  };
  const code = field('code');
  const versionText = field('version');
  const displayName = field('displayName');
  const referenceNotes = field('referenceNotes');
  const requiredMaterials = field('requiredMaterials');
  const requiredPolicies = field('requiredPolicies');
  if (
    !code ||
    !/^[a-z][a-z0-9_-]{1,63}$/u.test(code) ||
    !versionText ||
    !/^[1-9][0-9]{0,5}$/u.test(versionText) ||
    !displayName ||
    !referenceNotes ||
    !requiredMaterials ||
    requiredPolicies === null
  ) {
    return { error: '模板参数无效；请填写行业、版本和资料清单。', created: null };
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库暂不可用。', created: null };
  const lines = (value: string): string[] =>
    value
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);
  try {
    const created = await new MySqlIndustryTemplateRepository(database.config).create({
      code,
      version: Number(versionText),
      displayName,
      referenceNotes,
      requiredMaterials: lines(requiredMaterials),
      requiredPolicies: lines(requiredPolicies),
      operatorId: operator,
    });
    revalidatePath('/');
    return { error: null, created: `${created.displayName} v${created.version}` };
  } catch (error) {
    return {
      error:
        error instanceof IndustryTemplateAlreadyExistsError
          ? '该行业代码和版本已存在；请刷新列表，确认后再填写新的版本号。'
          : '创建失败。请检查资料项长度与重复内容，再刷新列表核对是否已创建。',
      created: null,
    };
  }
}
