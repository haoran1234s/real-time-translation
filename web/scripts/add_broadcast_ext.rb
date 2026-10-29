# frozen_string_literal: true
#
# 在 Capacitor 生成的 iOS 工程中添加 ReplayKit 录屏广播扩展 Target（TransForgeBroadcast），
# 并将其嵌入主 App 的 PlugIns 目录。
# 用法（在 web/ 目录下执行）：ruby scripts/add_broadcast_ext.rb
#
require 'fileutils'
require 'xcodeproj'

EXT_NAME = 'TransForgeBroadcast'
SRC_DIR = File.expand_path("../ios-ext/#{EXT_NAME}", __dir__)
IOS_APP_DIR = File.expand_path('../ios/App', __dir__)
PROJECT_PATH = File.join(IOS_APP_DIR, 'App.xcodeproj')
DEST_DIR = File.join(IOS_APP_DIR, EXT_NAME)

abort("[ERROR] 未找到扩展源码目录: #{SRC_DIR}") unless Dir.exist?(SRC_DIR)
abort("[ERROR] 未找到 Xcode 工程: #{PROJECT_PATH}") unless Dir.exist?(PROJECT_PATH)

# 1. 复制扩展源码到 iOS 工程目录
FileUtils.rm_rf(DEST_DIR)
FileUtils.mkdir_p(DEST_DIR)
FileUtils.cp_r(Dir.glob(File.join(SRC_DIR, '*')), DEST_DIR)

project = Xcodeproj::Project.open(PROJECT_PATH)
app_target = project.targets.find { |t| t.name == 'App' }
abort('[ERROR] 未找到主 App Target') if app_target.nil?

if project.targets.any? { |t| t.name == EXT_NAME }
  puts "[SKIP] #{EXT_NAME} Target 已存在"
  exit 0
end

app_bundle_id = app_target.build_configurations.first.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] || 'com.haoran.transforge'
marketing = app_target.build_configurations.first.build_settings['MARKETING_VERSION'] || '1.0'
build_no = app_target.build_configurations.first.build_settings['CURRENT_PROJECT_VERSION'] || '1'

# 2. 新建扩展 Target
ext_target = project.new_target(:app_extension, EXT_NAME, :ios, '16.0')

# 3. 文件分组与源码
group = project.main_group.find_subpath(EXT_NAME, true)
group.set_source_tree('<group>')
group.set_path(EXT_NAME)
swift_ref = group.new_reference('SampleHandler.swift')
group.new_reference('Info.plist')
ext_target.add_file_references([swift_ref])

# 4. 构建配置
ext_target.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{app_bundle_id}.broadcast"
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['INFOPLIST_FILE'] = "#{EXT_NAME}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['SWIFT_VERSION'] = '5.0'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['MARKETING_VERSION'] = marketing
  s['CURRENT_PROJECT_VERSION'] = build_no
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['ENABLE_BITCODE'] = 'NO'
end

# 5. 主 App 依赖扩展并嵌入到 PlugIns
app_target.add_dependency(ext_target)
embed_phase = app_target.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
              app_target.new_copy_files_build_phase('Embed Foundation Extensions')
embed_phase.symbol_dst_subfolder_spec = :plug_ins
build_file = embed_phase.add_file_reference(ext_target.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

project.save
puts "[OK] 已添加录屏广播扩展 #{EXT_NAME}（Bundle ID: #{app_bundle_id}.broadcast）并嵌入主 App"
