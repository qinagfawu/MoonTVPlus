/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { OpenListClient } from '@/lib/openlist.client';

export const runtime = 'nodejs';

// 服务器端内存缓存
const serverCache = {
  methodConfigs: new Map<string, { data: any; timestamp: number }>(),
  proxyRequests: new Map<string, { data: any; timestamp: number }>(),
  CACHE_DURATION: 24 * 60 * 60 * 1000, // 24小时缓存
};

// 正在下载的音频任务追踪（防止重复下载）
const downloadingTasks = new Map<string, Promise<void>>();

// 获取 TuneHub 配置
async function getTuneHubConfig() {
  const config = await getConfig();
  const musicConfig = config?.MusicConfig;

  const enabled = musicConfig?.TuneHubEnabled ?? false;
  const baseUrl =
    musicConfig?.TuneHubBaseUrl ||
    process.env.TUNEHUB_BASE_URL ||
    'https://tunehub.sayqz.com/api';
  const apiKey = musicConfig?.TuneHubApiKey || process.env.TUNEHUB_API_KEY || '';

  return { enabled, baseUrl, apiKey, musicConfig };
}

// 获取 OpenList 客户端
async function getOpenListClient(): Promise<OpenListClient | null> {
  const config = await getConfig();
  const musicConfig = config?.MusicConfig;

  console.log('[Music OpenList] 配置检查:', {
    enabled: musicConfig?.OpenListCacheEnabled,
    hasURL: !!musicConfig?.OpenListCacheURL,
    hasUsername: !!musicConfig?.OpenListCacheUsername,
    hasPassword: !!musicConfig?.OpenListCachePassword,
  });

  if (!musicConfig?.OpenListCacheEnabled) {
    console.warn('[Music OpenList] OpenList 缓存未启用');
    return null;
  }

  const url = musicConfig.OpenListCacheURL;
  const username = musicConfig.OpenListCacheUsername;
  const password = musicConfig.OpenListCachePassword;

  if (!url || !username || !password) {
    console.warn('[Music OpenList] 配置不完整，跳过 OpenList 缓存');
    return null;
  }

  console.log('[Music OpenList] 创建 OpenList 客户端:', url);
  return new OpenListClient(url, username, password);
}

// 异步下载音频文件并上传到 OpenList
async function cacheAudioToOpenList(
  openListClient: OpenListClient,
  audioUrl: string,
  platform: string,
  songId: string,
  quality: string,
  cachePath: string
): Promise<void> {
  const taskKey = `${platform}-${songId}-${quality}`;

  // 检查是否已经有任务在下载
  const existingTask = downloadingTasks.get(taskKey);
  if (existingTask) {
    console.log('[Music Cache] 该音频正在下载中，跳过重复任务:', taskKey);
    return existingTask;
  }

  // 创建下载任务
  const downloadTask = (async () => {
    try {
      const audioPath = `${cachePath}/${platform}/audio/${songId}-${quality}.mp3`;

      console.log('[Music Cache] 开始下载音频:', audioUrl);
      const audioResponse = await fetch(audioUrl);

      if (!audioResponse.ok) {
        console.error('[Music Cache] 下载音频失败:', audioResponse.status);
        return;
      }

      const audioBuffer = await audioResponse.arrayBuffer();
      const audioBlob = Buffer.from(audioBuffer);

      console.log('[Music Cache] 音频下载完成，大小:', audioBlob.length, 'bytes');
      console.log('[Music Cache] 开始上传到 OpenList:', audioPath);

      // OpenList 的 uploadFile 方法需要字符串，但我们需要上传二进制文件
      // 使用 PUT 方法直接上传
      const token = await (openListClient as any).getToken();
      console.log('[Music Cache] 获取到 Token，开始上传请求');

      const uploadResponse = await fetch(`${(openListClient as any).baseURL}/api/fs/put`, {
        method: 'PUT',
        headers: {
          'Authorization': token,
          'Content-Type': 'audio/mpeg',
          'File-Path': encodeURIComponent(audioPath),
          'As-Task': 'false',
        },
        body: audioBlob,
      });

      console.log('[Music Cache] 上传响应状态:', uploadResponse.status);

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error('[Music Cache] 上传音频失败:', uploadResponse.status, errorText);
        return;
      }

      const responseData = await uploadResponse.json();
      console.log('[Music Cache] 上传响应数据:', responseData);
      console.log('[Music Cache] 音频成功缓存到 OpenList:', audioPath);
    } catch (error) {
      console.error('[Music Cache] 缓存音频到 OpenList 失败:', error);
    } finally {
      // 任务完成后从追踪中移除
      downloadingTasks.delete(taskKey);
    }
  })();

  // 将任务添加到追踪
  downloadingTasks.set(taskKey, downloadTask);

  return downloadTask;
}

// 检查并替换音频 URL 为 OpenList URL
async function replaceAudioUrlsWithOpenList(
  data: any,
  openListClient: OpenListClient | null,
  platform: string,
  quality: string,
  cachePath: string
): Promise<any> {
  if (!openListClient || !data?.data) {
    console.log('[Music Cache] 跳过音频替换:', { hasClient: !!openListClient, hasData: !!data?.data });
    return data;
  }

  // TuneHub 返回的数据结构是 { code: 0, data: { data: [...], total: 1 } }
  // 需要提取内层的 data 数组
  const songsData = data.data.data || data.data;
  const songs = Array.isArray(songsData) ? songsData : [songsData];

  console.log('[Music Cache] 开始处理', songs.length, '首歌曲');

  for (const song of songs) {
    if (!song?.id || !song?.url) {
      console.log('[Music Cache] 跳过无效歌曲:', song);
      continue;
    }

    const audioPath = `${cachePath}/${platform}/audio/${song.id}-${quality}.mp3`;

    try {
      // 检查 OpenList 是否有这个音频文件
      const fileResponse = await openListClient.getFile(audioPath);

      if (fileResponse.code === 200 && fileResponse.data?.raw_url) {
        console.log('[Music Cache] 使用 OpenList 缓存的音频:', audioPath);
        song.url = fileResponse.data.raw_url;
        song.cached = true; // 标记为已缓存
      } else {
        // OpenList 返回非200，说明文件不存在，开始下载
        console.log('[Music Cache] OpenList 无缓存（code:', fileResponse.code, '），异步下载音频');
        song.cached = false;

        // 异步上传，不阻塞响应
        cacheAudioToOpenList(openListClient, song.url, platform, song.id, quality, cachePath)
          .catch(error => {
            console.error('[Music Cache] 异步缓存音频失败:', error);
          });
      }
    } catch (error) {
      // getFile 抛出异常，也说明文件不存在或网络错误
      console.log('[Music Cache] 检查 OpenList 音频缓存失败:', error);
      song.cached = false;

      // 即使检查失败，也尝试下载
      cacheAudioToOpenList(openListClient, song.url, platform, song.id, quality, cachePath)
        .catch(err => {
          console.error('[Music Cache] 异步缓存音频失败:', err);
        });
    }
  }

  return data;
}

// 通用请求处理函数
async function proxyRequest(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    return response;
  } catch (error) {
    console.error('TuneHub API 请求失败:', error);
    throw error;
  }
}

// 获取方法配置并执行请求
async function executeMethod(
  baseUrl: string,
  platform: string,
  func: string,
  variables: Record<string, string> = {}
): Promise<any> {
  // 1. 获取方法配置
  const cacheKey = `method-config-${platform}-${func}`;
  let config: any;

  const cached = serverCache.methodConfigs.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
    config = cached.data.data;
  } else {
    const response = await proxyRequest(`${baseUrl}/v1/methods/${platform}/${func}`);
    const data = await response.json();
    serverCache.methodConfigs.set(cacheKey, { data, timestamp: Date.now() });
    config = data.data;
  }

  if (!config) {
    throw new Error('无法获取方法配置');
  }

  // 2. 替换模板变量
  let url = config.url;
  const params: Record<string, string> = {};

  // 先将 variables 中的值转换为可执行的变量
  const evalContext: Record<string, any> = {};
  for (const [key, value] of Object.entries(variables)) {
    // 尝试将字符串转换为数字（如果可能）
    const numValue = Number(value);
    evalContext[key] = isNaN(numValue) ? value : numValue;
  }

  // 递归处理对象中的模板变量
  function processTemplateValue(value: any): any {
    if (typeof value === 'string') {
      // 处理包含模板变量的表达式
      const expressionRegex = /\{\{(.+?)\}\}/g;
      return value.replace(expressionRegex, (match, expression) => {
        try {
          // 创建一个函数来执行表达式，传入所有变量作为参数
          // eslint-disable-next-line no-new-func
          const func = new Function(...Object.keys(evalContext), `return ${expression}`);
          const result = func(...Object.values(evalContext));
          return String(result);
        } catch (err) {
          console.error(`[executeMethod] 执行表达式失败: ${expression}`, err);
          return '0'; // 默认值
        }
      });
    } else if (Array.isArray(value)) {
      return value.map(item => processTemplateValue(item));
    } else if (typeof value === 'object' && value !== null) {
      const result: any = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = processTemplateValue(v);
      }
      return result;
    }
    return value;
  }

  // 处理 URL 参数
  if (config.params) {
    for (const [key, value] of Object.entries(config.params)) {
      params[key] = processTemplateValue(value);
    }
  }

  // 处理 POST body
  let processedBody = config.body;
  if (config.body) {
    processedBody = processTemplateValue(config.body);
  }

  // 3. 构建完整 URL
  if (config.method === 'GET' && Object.keys(params).length > 0) {
    const urlObj = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      urlObj.searchParams.append(key, value);
    }
    url = urlObj.toString();
  }

  // 4. 发起请求
  const requestOptions: RequestInit = {
    method: config.method || 'GET',
    headers: config.headers || {},
  };

  if (config.method === 'POST' && processedBody) {
    requestOptions.body = JSON.stringify(processedBody);
    requestOptions.headers = {
      ...requestOptions.headers,
      'Content-Type': 'application/json',
    };
  }

  const response = await proxyRequest(url, requestOptions);
  let data = await response.json();

  // 5. 执行 transform 函数（如果有）
  if (config.transform) {
    try {
      // eslint-disable-next-line no-eval
      const transformFn = eval(`(${config.transform})`);
      data = transformFn(data);
    } catch (err) {
      console.error('[executeMethod] Transform 函数执行失败:', err);
    }
  }

  // 6. 处理酷我音乐的图片 URL（转换为代理 URL）
  if (platform === 'kuwo') {
    const processKuwoImages = (obj: any): any => {
      if (typeof obj === 'string' && obj.startsWith('http://') && obj.includes('kwcdn.kuwo.cn')) {
        // 将 HTTP 图片 URL 转换为代理 URL
        return `/api/music/proxy?url=${encodeURIComponent(obj)}`;
      } else if (Array.isArray(obj)) {
        return obj.map(item => processKuwoImages(item));
      } else if (typeof obj === 'object' && obj !== null) {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = processKuwoImages(value);
        }
        return result;
      }
      return obj;
    };

    data = processKuwoImages(data);
  }

  return data;
}

// GET 请求处理
export async function GET(request: NextRequest) {
  try {
    const { enabled, baseUrl } = await getTuneHubConfig();

    if (!enabled) {
      return NextResponse.json(
        { error: '音乐功能未开启' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    if (!action) {
      return NextResponse.json(
        { error: '缺少 action 参数' },
        { status: 400 }
      );
    }

    // 处理不同的 action
    switch (action) {
      case 'toplists': {
        // 获取排行榜列表
        const platform = searchParams.get('platform');
        if (!platform) {
          return NextResponse.json(
            { error: '缺少 platform 参数' },
            { status: 400 }
          );
        }

        const cacheKey = `toplists-${platform}`;
        const cached = serverCache.proxyRequests.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
          return NextResponse.json(cached.data);
        }

        const data = await executeMethod(baseUrl, platform, 'toplists');
        serverCache.proxyRequests.set(cacheKey, { data, timestamp: Date.now() });

        return NextResponse.json(data);
      }

      case 'toplist': {
        // 获取排行榜详情
        const platform = searchParams.get('platform');
        const id = searchParams.get('id');

        if (!platform || !id) {
          return NextResponse.json(
            { error: '缺少 platform 或 id 参数' },
            { status: 400 }
          );
        }

        const cacheKey = `toplist-${platform}-${id}`;
        const cached = serverCache.proxyRequests.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
          return NextResponse.json(cached.data);
        }

        const data = await executeMethod(baseUrl, platform, 'toplist', { id });
        serverCache.proxyRequests.set(cacheKey, { data, timestamp: Date.now() });

        return NextResponse.json(data);
      }

      case 'playlist': {
        // 获取歌单详情
        const platform = searchParams.get('platform');
        const id = searchParams.get('id');

        if (!platform || !id) {
          return NextResponse.json(
            { error: '缺少 platform 或 id 参数' },
            { status: 400 }
          );
        }

        const cacheKey = `playlist-${platform}-${id}`;
        const cached = serverCache.proxyRequests.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
          return NextResponse.json(cached.data);
        }

        const data = await executeMethod(baseUrl, platform, 'playlist', { id });
        serverCache.proxyRequests.set(cacheKey, { data, timestamp: Date.now() });

        return NextResponse.json(data);
      }

      case 'search': {
        // 搜索歌曲
        const platform = searchParams.get('platform');
        const keyword = searchParams.get('keyword');
        const page = searchParams.get('page') || '1';
        const pageSize = searchParams.get('pageSize') || '20';

        if (!platform || !keyword) {
          return NextResponse.json(
            { error: '缺少 platform 或 keyword 参数' },
            { status: 400 }
          );
        }

        const cacheKey = `search-${platform}-${keyword}-${page}-${pageSize}`;
        const cached = serverCache.proxyRequests.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
          return NextResponse.json(cached.data);
        }

        // 注意：不同平台可能使用不同的变量名
        // 统一传递 keyword, page, pageSize, limit (limit = pageSize)
        const data = await executeMethod(baseUrl, platform, 'search', {
          keyword,
          page,
          pageSize,
          limit: pageSize, // 有些平台使用 limit 而不是 pageSize
        });

        serverCache.proxyRequests.set(cacheKey, { data, timestamp: Date.now() });

        return NextResponse.json(data);
      }

      default:
        return NextResponse.json(
          { error: '不支持的 action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('音乐 API 错误:', error);
    return NextResponse.json(
      {
        error: '请求失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}

// POST 请求处理（用于解析歌曲）
export async function POST(request: NextRequest) {
  try {
    const { enabled, baseUrl, apiKey } = await getTuneHubConfig();

    if (!enabled) {
      return NextResponse.json(
        { error: '音乐功能未开启' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { error: '缺少 action 参数' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'parse': {
        // 解析歌曲（需要 API Key）
        if (!apiKey) {
          return NextResponse.json(
            {
              code: -1,
              error: '未配置 TuneHub API Key',
              message: '未配置 TuneHub API Key'
            },
            { status: 403 }
          );
        }

        const { platform, ids, quality } = body;
        if (!platform || !ids) {
          return NextResponse.json(
            {
              code: -1,
              error: '缺少 platform 或 ids 参数',
              message: '缺少 platform 或 ids 参数'
            },
            { status: 400 }
          );
        }

        // 添加缓存支持
        const qualityKey = quality || '320k';
        const idsKey = Array.isArray(ids) ? ids.join(',') : ids;
        const cacheKey = `parse-${platform}-${idsKey}-${qualityKey}`;

        // 1. 先检查内存缓存
        const cached = serverCache.proxyRequests.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < serverCache.CACHE_DURATION) {
          console.log('[Music Cache] 从内存缓存返回');
          return NextResponse.json(cached.data);
        }

        // 2. 检查 OpenList 缓存
        const openListClient = await getOpenListClient();
        const config = await getConfig();
        const cachePath = config?.MusicConfig?.OpenListCachePath || '/music-cache';

        console.log('[Music Cache] OpenList 客户端状态:', openListClient ? '已创建' : '未创建');
        console.log('[Music Cache] 缓存路径:', cachePath);

        if (openListClient) {
          try {
            const openListPath = `${cachePath}/${platform}/${idsKey}-${qualityKey}.json`;
            console.log('[Music Cache] 尝试从 OpenList 读取:', openListPath);

            const fileResponse = await openListClient.getFile(openListPath);
            if (fileResponse.code === 200 && fileResponse.data?.raw_url) {
              // 下载缓存文件
              const cacheResponse = await fetch(fileResponse.data.raw_url);
              if (cacheResponse.ok) {
                const cachedData = await cacheResponse.json();
                console.log('[Music Cache] 从 OpenList 缓存返回');

                // 更新内存缓存
                serverCache.proxyRequests.set(cacheKey, { data: cachedData, timestamp: Date.now() });

                return NextResponse.json(cachedData);
              }
            }
          } catch (error) {
            console.log('[Music Cache] OpenList 缓存未命中或读取失败:', error);
          }
        }

        // 3. 调用 TuneHub API 解析
        try {
          console.log('[Music Cache] 调用 TuneHub API 解析');
          const response = await proxyRequest(`${baseUrl}/v1/parse`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
            },
            body: JSON.stringify({
              platform,
              ids,
              quality: qualityKey,
            }),
          });

          const data = await response.json();
          console.log('TuneHub 解析响应:', data);

          // 如果 TuneHub 返回错误，包装成统一格式
          if (!response.ok || data.code !== 0) {
            return NextResponse.json({
              code: data.code || -1,
              message: data.message || data.error || '解析失败',
              error: data.error || data.message || '解析失败',
            });
          }

          // 4. 缓存成功的解析结果到内存
          serverCache.proxyRequests.set(cacheKey, { data, timestamp: Date.now() });

          // 5. 检查并替换音频 URL 为 OpenList URL（如果已缓存）
          // 同时异步下载未缓存的音频
          const finalData = await replaceAudioUrlsWithOpenList(
            data,
            openListClient,
            platform,
            qualityKey,
            cachePath
          );

          // 6. 缓存解析结果到 OpenList（异步，不阻塞响应）
          if (openListClient) {
            const jsonPath = `${cachePath}/${platform}/${idsKey}-${qualityKey}.json`;
            openListClient.uploadFile(jsonPath, JSON.stringify(finalData, null, 2))
              .then(() => {
                console.log('[Music Cache] 成功缓存解析结果到 OpenList:', jsonPath);
              })
              .catch((error) => {
                console.error('[Music Cache] 缓存解析结果到 OpenList 失败:', error);
              });
          }

          return NextResponse.json(finalData);
        } catch (error) {
          console.error('解析歌曲失败:', error);
          return NextResponse.json({
            code: -1,
            message: '解析请求失败',
            error: (error as Error).message,
          });
        }
      }

      default:
        return NextResponse.json(
          { error: '不支持的 action' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('音乐 API 错误:', error);
    return NextResponse.json(
      {
        error: '请求失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
