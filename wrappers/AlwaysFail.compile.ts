import { CompilerConfig } from '@ton-community/blueprint'

export const compile: CompilerConfig = {
  targets: ["alwaysfail.fc"],
  sources: () => "() recv_internal() impure { throw(100); }",
}
