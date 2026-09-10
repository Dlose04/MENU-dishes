/**
 * 页脚。只放一句数据说明 + 打开设置的入口。
 *
 * 导出 / 导入 / 找回示例菜谱 / 清空数据这些操作**不在这里重复实现**，
 * 全部留在设置浮层里，免得两套入口各走各的、慢慢跑偏。
 */
export function Footer({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <footer className="footer">
      <span className="note">📒 数据只存在这台设备上，不会上传</span>
      <span className="spacer" />
      <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
        <span aria-hidden="true">⚙️</span> 设置
      </button>
    </footer>
  )
}
