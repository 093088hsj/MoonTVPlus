/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { fetchDoubanData } from '@/lib/douban';
import { getCached } from '@/lib/persistent-cache';
import { getTMDBTrendingContent, getTMDBVideos } from '@/lib/tmdb.client';

// 缓存 3 小时。原先用模块级变量缓存，在 Cloudflare Workers / EdgeOne 这类
// 无状态运行时上几乎不命中（实例随时回收、各边缘节点独立），导致每次请求都要
// 重新聚合豆瓣/TMDB 数据并为每个条目串行拉预告片，实测冷路径 5 秒以上。
// 改为 getCached：内存做 L1、落库做 L2，缓存能跨实例跨节点共享。
const CACHE_DURATION = 3 * 60 * 60 * 1000; // 3小时

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // 获取配置
    const config = await getConfig();
    const bannerDataSource = config.SiteConfig?.BannerDataSource || 'Douban';

    const result = await getCached<any>(
      `tmdb-trending:${bannerDataSource}`,
      CACHE_DURATION,
      () => fetchBannerContent(bannerDataSource, config)
    );

    if (result?.code === 400) {
      return NextResponse.json(result, { status: 400 });
    }

    // 数据是全站共享的，允许浏览器缓存，避免每次进首页都打这个接口
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=1800, stale-while-revalidate=7200',
      },
    });
  } catch (error) {
    console.error('获取热门内容失败:', error);
    return NextResponse.json(
      { code: 500, message: '获取热门内容失败' },
      { status: 500 }
    );
  }
}

async function fetchBannerContent(
  bannerDataSource: string,
  config: Awaited<ReturnType<typeof getConfig>>
): Promise<any> {
  if (bannerDataSource === 'Douban') {
    const result: any = await getDoubanBannerContent();
    result.source = 'Douban';
    return result;
  }

  if (bannerDataSource === 'TX') {
    const result: any = await getTXBannerContent();
    result.source = 'TX';
    return result;
  }

  // TMDB 数据源（默认）
  const apiKey = config.SiteConfig?.TMDBApiKey;
  const proxy = config.SiteConfig?.TMDBProxy;
  const reverseProxy = config.SiteConfig?.TMDBReverseProxy;

  if (!apiKey) {
    return { code: 400, message: 'TMDB API Key 未配置' };
  }

  const result: any = await getTMDBTrendingContent(apiKey, proxy, reverseProxy);

  // 为每个项目获取视频数据
  if (result.code === 200 && result.list) {
    const itemsWithVideos = await Promise.all(
      result.list.map(async (item: any) => {
        const videoKey = await getTMDBVideos(
          apiKey,
          item.media_type,
          item.id,
          proxy,
          reverseProxy
        );
        return { ...item, video_key: videoKey };
      })
    );
    result.list = itemsWithVideos;
  }

  result.source = 'TMDB';
  return result;
}

/**
 * 获取TX轮播图内容
 */
async function getTXBannerContent(): Promise<{ code: number; list: any[] }> {
  try {
    // TX API 配置
    const txApiUrl = 'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2&vdevice_guid=a458b2024f8d6f14';
    const requestBody = {
      page_params: {
        page_type: 'channel',
        page_id: '100101',
        scene: 'channel',
        new_mark_label_enabled: '1',
        vl_to_mvl: '',
        free_watch_trans_info: '{"ad_frequency_control_time_list":{}}',
        ad_exp_ids: '',
        ams_cookies: 'lv_play_index=33; o_minduid=PBUiqKSklDHZsTs2JqmXhTsczQfz5uzY; appuser=CC19AC2067F39B71',
        ad_trans_data: '{"ad_request_id":"uglfjd6-26n6yw4-gs9tlvy-k19l366","game_sessions":[]}',
        skip_privacy_types: '0',
        support_click_scan: '1',
      },
      page_bypass_params: {
        params: {
          platform_id: '2',
          caller_id: '3000010',
          data_mode: 'default',
          user_mode: 'default',
          specified_strategy: '',
          page_type: 'channel',
          page_id: '100101',
          scene: 'channel',
          new_mark_label_enabled: '1',
        },
        scene: 'channel',
        app_version: '',
        abtest_bypass_id: 'a458b2024f8d6f14',
      },
      page_context: null,
    };

    // 发送请求到TX API
    const response = await fetch(txApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000),
    });
	
    if (!response.ok) {
      console.error('TX API 请求失败:', response.status, response.statusText);
      return { code: response.status, list: [] };
    }

    const data = await response.json();

    // 解析响应数据
    const bannerItems = parseTXBannerData(data);

    return {
      code: 200,
      list: bannerItems,
    };
  } catch (error) {
    console.error('获取 TX 轮播图数据失败:', error);
    return { code: 500, list: [] };
  }
}

/**
 * 解析TX API响应数据，提取轮播图信息
 */
function parseTXBannerData(data: any): any[] {
  try {
    const cardList = data?.data?.CardList;
    if (!Array.isArray(cardList)) {
      return [];
    }

    // 找到所有类型为 pc_shelves 的卡片
    const pcShelvesCards = cardList.filter((card: any) => card.type === 'pc_shelves');
    if (pcShelvesCards.length === 0) {
      return [];
    }

    // 尝试每个 pc_shelves 卡片，直到找到有效数据
    for (let i = 0; i < pcShelvesCards.length; i++) {
      const pcShelvesCard = pcShelvesCards[i];

      const cards = pcShelvesCard?.children_list?.list?.cards;
      if (!Array.isArray(cards) || cards.length === 0) {
        continue;
      }

    // 转换为统一格式
    const cardsWithParams = cards.filter((card: any) => card.params);

    const mappedItems = cardsWithParams.map((card: any, index: number) => {
        const params = card.params;

        // 获取标题（优先使用title）
        const title = params.title || '';

        // 获取子标题（优先使用priority_sub_title，其次rec_normal_reason）
        const subtitle = params.priority_sub_title || params.rec_normal_reason || '';

        // 获取标签（用"|"分割）
        const topicLabel = params.topic_label || '';
        const tags = topicLabel ? topicLabel.split('|').filter(Boolean) : [];

        // 获取背景图
        const backdropPath = params.priority_image_url || '';

        return {
          id: index + 1, // 使用索引作为ID
          title,
          subtitle,
          tags,
          backdrop_path: backdropPath,
          poster_path: backdropPath, // 使用相同的图片
          release_date: '',
          overview: subtitle,
          vote_average: 0,
          media_type: 'tv',
          genre_ids: [],
        };
      });

      const bannerItems = mappedItems.filter((item: any) => {
        // 只保留有标题和背景图的项目
        if (!item.title || !item.backdrop_path) return false;
        // 剔除标题包含"免费合集"的数据
        if (item.title.includes('免费合集')) return false;
        return true;
      });

      if (bannerItems.length > 0) {
        return bannerItems;
      }
    }

    // 所有 pc_shelves 卡片都没有有效数据
    return [];
  } catch (error) {
    console.error('解析 TX 轮播图数据失败:', error);
    return [];
  }
}

/**
 * 获取豆瓣轮播图内容
 */
async function getDoubanBannerContent(): Promise<{ code: number; list: any[] }> {
  try {
    // 获取豆瓣热门电影
    const hotMoviesUrl = 'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=0&limit=10&category=热门&type=全部';

    interface DoubanHotMovie {
      id: string;
      title: string;
      card_subtitle?: string;
      pic?: {
        large: string;
        normal: string;
      };
      rating?: {
        value: number;
      };
    }

    interface DoubanHotMoviesResponse {
      items: DoubanHotMovie[];
    }

    const hotMoviesData = await fetchDoubanData<DoubanHotMoviesResponse>(hotMoviesUrl);

    if (!hotMoviesData.items || hotMoviesData.items.length === 0) {
      return { code: 200, list: [] };
    }

    // 取前5个电影
    const topMovies = hotMoviesData.items.slice(0, 5);

    // 为每个电影获取详情信息
    const bannerItems = await Promise.all(
      topMovies.map(async (movie) => {
        try {
          const detailUrl = `https://m.douban.com/rexxar/api/v2/subject/${movie.id}`;

          interface DoubanDetailResponse {
            id: string;
            title: string;
            original_title?: string;
            year: string;
            rating?: {
              value: number;
            };
            intro?: string;
            genres?: string[];
            cover_url?: string;
            trailers?: Array<{
              video_url?: string;
              [key: string]: any;
            }>;
            [key: string]: any;
          }

          const detail = await fetchDoubanData<DoubanDetailResponse>(detailUrl);

          // 获取横屏图片
          const backdropPath = detail.cover_url || movie.pic?.large || movie.pic?.normal || '';

          // 提取年份
          const year = detail.year || movie.card_subtitle?.match(/(\d{4})/)?.[1] || '';

          // 从card_subtitle提取标签（只读取第二个部分，通过空格分割）
          let tags: string[] = [];
          if (movie.card_subtitle) {
            const parts = movie.card_subtitle.split('/').map(s => s.trim());
            // 过滤掉年份（纯数字）和空字符串
            const filteredParts = parts.filter(part =>
              part && !/^\d{4}$/.test(part)
            );
            // 取第二个部分（类型），通过空格分割
            if (filteredParts.length >= 2) {
              tags = filteredParts[1].split(/\s+/).filter(t => t);
            }
          }

          return {
            id: movie.id,
            title: detail.title,
            backdrop_path: backdropPath,
            poster_path: backdropPath,
            release_date: year,
            overview: detail.intro || '',
            vote_average: detail.rating?.value || movie.rating?.value || 0,
            media_type: 'movie',
            genre_ids: [],
            genres: tags, // 使用从card_subtitle提取的标签
            video_key: null, // 豆瓣不使用YouTube key
          };
        } catch (error) {
          console.error(`获取豆瓣电影 ${movie.id} 详情失败:`, error);

          // 从card_subtitle提取标签（只读取第二个部分，通过空格分割）
          let tags: string[] = [];
          if (movie.card_subtitle) {
            const parts = movie.card_subtitle.split('/').map(s => s.trim());
            // 过滤掉年份（纯数字）和空字符串
            const filteredParts = parts.filter(part =>
              part && !/^\d{4}$/.test(part)
            );
            // 取第二个部分（类型），通过空格分割
            if (filteredParts.length >= 2) {
              tags = filteredParts[1].split(/\s+/).filter(t => t);
            }
          }

          // 如果获取详情失败，使用基本信息
          return {
            id: movie.id,
            title: movie.title,
            backdrop_path: movie.pic?.large || movie.pic?.normal || '',
            poster_path: movie.pic?.large || movie.pic?.normal || '',
            release_date: movie.card_subtitle?.match(/(\d{4})/)?.[1] || '',
            overview: '',
            vote_average: movie.rating?.value || 0,
            media_type: 'movie',
            genre_ids: [],
            genres: tags, // 使用从card_subtitle提取的标签
            video_key: null,
          };
        }
      })
    );

    // 过滤掉没有图片的项目
    const validBannerItems = bannerItems.filter(item => item.backdrop_path);

    return {
      code: 200,
      list: validBannerItems,
    };
  } catch (error) {
    console.error('获取豆瓣轮播图数据失败:', error);
    return { code: 500, list: [] };
  }
}
