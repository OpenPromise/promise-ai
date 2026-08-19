import type { Tool } from './index.js';

interface WeatherInput {
  city: string;
}

const WEATHER_CODE: Record<number, string> = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
};

interface GeoResult {
  results?: Array<{ latitude: number; longitude: number; name: string; country?: string }>;
}

interface ForecastResult {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
}

export function createWeatherTool(fetchImpl: typeof fetch = fetch): Tool {
  return {
    name: 'weather.get',
    description: '查询指定城市的当前天气（温度、湿度、天气状况、风速）。',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名称，如 北京、上海、杭州',
        },
      },
      required: ['city'],
    },
    permissionLevel: 0,
    async execute(input: unknown, context) {
      const { city } = (input ?? {}) as WeatherInput;
      if (!city?.trim()) {
        return { ok: false, error: '缺少 city 参数' };
      }

      try {
        const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
        geoUrl.searchParams.set('name', city);
        geoUrl.searchParams.set('count', '1');
        geoUrl.searchParams.set('language', 'zh');
        geoUrl.searchParams.set('format', 'json');

        const geoResponse = await fetchImpl(geoUrl, { signal: context.signal });
        if (!geoResponse.ok) {
          return { ok: false, error: `地理编码失败：HTTP ${geoResponse.status}` };
        }
        const geo = (await geoResponse.json()) as GeoResult;
        const place = geo.results?.[0];
        if (!place) {
          return { ok: false, error: `找不到城市：${city}` };
        }

        const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
        forecastUrl.searchParams.set('latitude', String(place.latitude));
        forecastUrl.searchParams.set('longitude', String(place.longitude));
        forecastUrl.searchParams.set(
          'current',
          'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
        );
        forecastUrl.searchParams.set('timezone', 'auto');

        const forecastResponse = await fetchImpl(forecastUrl, { signal: context.signal });
        if (!forecastResponse.ok) {
          return { ok: false, error: `天气查询失败：HTTP ${forecastResponse.status}` };
        }
        const forecast = (await forecastResponse.json()) as ForecastResult;
        const current = forecast.current;
        if (!current) {
          return { ok: false, error: '天气服务未返回当前天气数据' };
        }

        const code = current.weather_code ?? 0;
        return {
          ok: true,
          data: {
            city: place.name,
            ...(place.country ? { country: place.country } : {}),
            condition: WEATHER_CODE[code] ?? `未知（代码 ${code}）`,
            temperatureCelsius: current.temperature_2m,
            humidityPercent: current.relative_humidity_2m,
            windSpeedKmh: current.wind_speed_10m,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: `天气查询失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
