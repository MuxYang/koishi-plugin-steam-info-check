export default {
  'steam-info': {
    config: {
      steamApiKey: 'Steam API Key（支持多个）',
      proxy: '代理地址，例如 http://127.0.0.1:7890',
      steamRequestInterval: '轮询间隔（秒）',
      steamDisableBroadcastOnStartup: '启动时禁用首次播报（仅预热缓存）',
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
      // logForwardTarget 和 adminId 已移除
    startBroadcastType: '玩家开始游戏时的播报方式（list/text_image/image/text）',
  },
  },
  commands: {
    steam: {
      bind: {
        usage: '用法：steam bind <steamId或好友码>',
        bind_success: '绑定成功！Steam ID: {0}',
        already_bound: '您已经绑定过帐号了！',
        current_bound: '您当前绑定的 Steam ID 为 {0}。',
        invalid_id: '请输入有效的 Steam ID或好友码。',
        id_not_found: '无法找到该 Steam ID或好友码。',
        error: '发生错误。',
        messages: {
          current_bound: '您当前绑定的 Steam ID 为 {0}。',
          already_bound: '您已经绑定过帐号了！',
          invalid_id: '请输入有效的 Steam ID或好友码。',
          id_not_found: '无法找到该 Steam ID或好友码。',
          bind_success: '绑定成功！Steam ID: {0}',
          error: '发生错误。',
        },
      },
      unbind: {
        usage: '用法：steam unbind',
        unbind_success: '解绑成功。',
        not_bound: '你还没有绑定 Steam。',
        error: '发生错误。',
        messages: {
          unbind_success: '解绑成功。',
          not_bound: '你还没有绑定 Steam。',
          error: '发生错误。',
        },
      },
      info: {
        usage: '用法：steam info [@user|steamId]',
        user_not_found: '未找到用户信息。',
        error: '发生错误。',
        messages: {
          user_not_found: '未找到用户信息。',
          error: '发生错误。',
        },
      },
      check: {
        usage: '用法：steam check',
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
        usage: '用法：steam enable',
        enable_success: '已开启本群播报。',
        error: '发生错误。',
        messages: {
          enable_success: '已开启本群播报。',
          error: '发生错误。',
        },
      },
      disable: {
        usage: '用法：steam disable',
        disable_success: '已关闭本群播报。',
        error: '发生错误。',
        messages: {
          disable_success: '已关闭本群播报。',
          error: '发生错误。',
        },
      },
      update: {
        usage: '用法：steam update <name> [@image]',
        args_missing: '参数缺失。',
        update_success: '更新群信息成功。',
        error: '发生错误。',
        messages: {
          usage: '用法：steam update <name> [@image]',
          update_success: '更新群信息成功。',
          error: '发生错误。',
        },
      },
      nickname: {
        usage: '用法：steam nickname <nickname>',
        not_bound: '你还没有绑定 Steam。',
        nickname_set: '昵称已设置为 {0}。',
        error: '发生错误。',
        messages: {
          not_bound: '你还没有绑定 Steam。',
          nickname_set: '昵称已设置为 {0}。',
          error: '发生错误。',
        },
      },
    },
  },
}
