export default {
  'steam-info': {
    config: {
      steamApiKey: 'Steam API Key（支持多个）',
      proxy: '代理地址，例如 http://127.0.0.1:7890',
      steamRequestInterval: '轮询间隔（秒）',
      steamBroadcastType: '播报类型：all（全部图片列表）、part（仅开始游戏时图片）、none（仅文字）',
      steamDisableBroadcastOnStartup: '启动时禁用首次播报（仅预热缓存）',
      logForwardTarget: '日志转发目标 QQ（填写 QQ 号）',
      fonts: {
        regular: '常规字体路径',
        light: '细体字体路径',
        bold: '粗体字体路径',
      },
      commandAuthority: {
        bind: '绑定命令权限',
        unbind: '解绑命令权限',
        info: '查看资料命令权限',
        check: '查看状态命令权限',
        enable: '启用播报命令权限',
        disable: '禁用播报命令权限',
        update: '更新群信息命令权限',
        nickname: '设置昵称命令权限',
      },
    },
  startBroadcast: {
    startBroadcastType: '玩家开始游戏时的播报方式（list/text_image/image/text）',
  },
  admin: {
    adminId: '插件管理员 QQ（拥有最高权限）'
  },
  },
  commands: {
    steam: {
      bind: {
        bind_success: '绑定成功！Steam ID: {0}',
        already_bound: '您已经绑定过帐号了！',
        current_bound: '您当前绑定的 Steam ID 为 {0}。',
        invalid_id: '请输入有效的 Steam ID。',
        id_not_found: '无法找到该 Steam ID。',
        error: '发生错误。',
        messages: {
          current_bound: '您当前绑定的 Steam ID 为 {0}。',
          already_bound: '您已经绑定过帐号了！',
          invalid_id: '请输入有效的 Steam ID。',
          id_not_found: '无法找到该 Steam ID。',
          bind_success: '绑定成功！Steam ID: {0}',
          error: '发生错误。',
        },
      },
      unbind: {
        unbind_success: '解绑成功。',
        not_bound: '你还没有绑定 Steam ID。',
        error: '发生错误。',
        messages: {
          unbind_success: '解绑成功。',
          not_bound: '你还没有绑定 Steam ID。',
          error: '发生错误。',
        },
      },
      info: {
        user_not_found: '未找到用户信息。',
        error: '发生错误。',
        messages: {
          user_not_found: '未找到用户信息。',
          error: '发生错误。',
        },
      },
      check: {
        no_binds: '本群尚无绑定用户。',
        api_error: '连接 Steam API 失败。',
        error: '发生错误。',
        messages: {
          no_binds: '本群尚无绑定用户。',
          api_error: '连接 Steam API 失败。',
          error: '发生错误。',
        },
      },
      enable: {
        enable_success: '已开启本群播报。',
        error: '发生错误。',
        messages: {
          enable_success: '已开启本群播报。',
          error: '发生错误。',
        },
      },
      disable: {
        disable_success: '已关闭本群播报。',
        error: '发生错误。',
        messages: {
          disable_success: '已关闭本群播报。',
          error: '发生错误。',
        },
      },
      update: {
        args_missing: '参数缺失。',
        update_success: '更新群信息成功。',
        error: '发生错误。',
        messages: {
          args_missing: '参数缺失。',
          update_success: '更新群信息成功。',
          error: '发生错误。',
        },
      },
      nickname: {
        not_bound: '你还没有绑定 Steam ID。',
        nickname_set: '昵称已设置为 {0}。',
        error: '发生错误。',
        messages: {
          not_bound: '你还没有绑定 Steam ID。',
          nickname_set: '昵称已设置为 {0}。',
          error: '发生错误。',
        },
      },
    },
  },
}
