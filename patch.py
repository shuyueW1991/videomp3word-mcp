import os

with open("src/index.ts", "r") as f:
    content = f.read()

old_str = """      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Conversion failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }"""

new_str = """      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const suggestion = errorMessage.toLowerCase().includes("token") || errorMessage.toLowerCase().includes("balance") || errorMessage.toLowerCase().includes("quota")
          ? "\\nHint: If you have run out of tokens, you can purchase more using the videomp3word_pay tool."
          : "";
        return {
          content: [
            {
              type: "text",
              text: `Conversion failed: ${errorMessage}${suggestion}`,
            },
          ],
          isError: true,
        };
      }"""

if old_str in content:
    content = content.replace(old_str, new_str)
    with open("src/index.ts", "w") as f:
        f.write(content)
    print("Patched successfully")
else:
    print("Old string not found")
