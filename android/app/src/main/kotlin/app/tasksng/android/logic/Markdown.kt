package app.tasksng.android.logic

/**
 * A small Markdown subset for task notes: headings, paragraphs, lists (with
 * `- [ ]` checklists), quotes, code, rules, **bold**, _italic_, ~~strike~~,
 * `code`, [links](https://…) and bare URLs.
 */
sealed interface Inline {
    data class Text(val text: String) : Inline
    data class Strong(val children: List<Inline>) : Inline
    data class Em(val children: List<Inline>) : Inline
    data class Del(val children: List<Inline>) : Inline
    data class Code(val text: String) : Inline
    data class Link(val href: String, val children: List<Inline>) : Inline
}

class ListItem(
    var children: List<Inline>,
    /** null = not a checklist item */
    val checked: Boolean?,
    /** Source line, so checking an item can edit the text. */
    val line: Int,
    var sub: Block.ListBlock? = null,
)

sealed interface Block {
    data class Heading(val level: Int, val children: List<Inline>) : Block
    data class Paragraph(val lines: List<List<Inline>>) : Block
    data class Quote(val lines: List<List<Inline>>) : Block
    data class CodeBlock(val text: String) : Block
    data object Rule : Block
    class ListBlock(val ordered: Boolean, val start: Int, val items: MutableList<ListItem> = mutableListOf()) : Block
}

private val LIST_ITEM = Regex("""^(\s*)([-*+]|\d{1,9}[.)])\s+(?:\[([ xX])]\s+)?(.*)$""")
private val HEADING = Regex("""^(#{1,3})[ \t]+(.*)$""")
private val FENCE = Regex("""^\s*```""")
private val RULE = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")
private val QUOTE = Regex("""^\s*>""")
private val LINE_BREAKS = Regex("\r\n?|[  \u0085]")

/** Only links that are safe to open. */
fun safeHref(url: String): String? {
    val u = url.trim()
    if (Regex("""^https?://\S+$""", RegexOption.IGNORE_CASE).matches(u) || Regex("""^mailto:\S+$""", RegexOption.IGNORE_CASE).matches(u)) return u
    if (Regex("""^www\.\S+$""", RegexOption.IGNORE_CASE).matches(u)) return "https://$u"
    return null
}

private fun indentOf(line: String) = line.replace("\t", "  ").takeWhile { it.isWhitespace() }.length

fun parseMarkdown(src: String): List<Block> {
    val lines = src.replace(LINE_BREAKS, "\n").split("\n")
    val blocks = mutableListOf<Block>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank()) {
            i++
            continue
        }
        if (FENCE.containsMatchIn(line)) {
            val body = mutableListOf<String>()
            i++
            while (i < lines.size && !FENCE.containsMatchIn(lines[i])) body += lines[i++]
            i++
            blocks += Block.CodeBlock(body.joinToString("\n"))
            continue
        }
        val h = HEADING.find(line)
        if (h != null) {
            blocks += Block.Heading(h.groupValues[1].length, parseInline(h.groupValues[2].replace(Regex("""\s+#+\s*$"""), "")))
            i++
            continue
        }
        if (RULE.matches(line)) {
            blocks += Block.Rule
            i++
            continue
        }
        if (QUOTE.containsMatchIn(line)) {
            val quote = mutableListOf<List<Inline>>()
            while (i < lines.size && QUOTE.containsMatchIn(lines[i])) quote += parseInline(lines[i++].replace(Regex("""^\s*>\s?"""), ""))
            blocks += Block.Quote(quote)
            continue
        }
        if (LIST_ITEM.matches(line)) {
            val (list, next) = parseList(lines, i, indentOf(line))
            blocks += list
            i = next
            continue
        }
        // A paragraph always takes at least this line, so parsing always moves on.
        val para = mutableListOf(parseInline(lines[i++]))
        while (i < lines.size && lines[i].isNotBlank() && !LIST_ITEM.matches(lines[i]) && !HEADING.matches(lines[i]) &&
            !Regex("""^\s*(>|```)""").containsMatchIn(lines[i])
        ) para += parseInline(lines[i++])
        blocks += Block.Paragraph(para)
    }
    return blocks
}

private fun parseList(lines: List<String>, start: Int, indent: Int): Pair<Block.ListBlock, Int> {
    val first = LIST_ITEM.find(lines[start])!!
    val ordered = first.groupValues[2][0].isDigit()
    val list = Block.ListBlock(ordered, if (ordered) first.groupValues[2].dropLast(1).toIntOrNull() ?: 1 else 1)
    var i = start
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank()) {
            // A blank line ends the list unless it continues right after.
            if (i + 1 < lines.size && LIST_ITEM.matches(lines[i + 1]) && indentOf(lines[i + 1]) >= indent) {
                i++
                continue
            }
            break
        }
        val m = LIST_ITEM.find(line)
        val ind = indentOf(line)
        if (m == null) {
            // Continuation text of the previous item.
            val last = list.items.lastOrNull()
            if (last != null && ind > indent) {
                last.children = merge(last.children + Inline.Text(" ") + parseInline(line.trim()))
                i++
                continue
            }
            break
        }
        if (ind < indent) break
        // Switching between bullets and numbers starts a new list.
        if (ind == indent && m.groupValues[2][0].isDigit() != ordered) break
        if (ind > indent && list.items.isNotEmpty()) {
            val (sub, next) = parseList(lines, i, ind)
            list.items.last().sub = sub
            i = next
            continue
        }
        val mark = m.groups[3]?.value
        list.items += ListItem(parseInline(m.groupValues[4]), mark?.let { it.lowercase() == "x" }, i)
        i++
    }
    return list to i
}

private class InlineRule(val re: Regex, val make: (MatchResult) -> Inline?)

private val RULES = listOf(
    InlineRule(Regex("""`([^`]+)`""")) { Inline.Code(it.groupValues[1]) },
    InlineRule(Regex("""\[([^\]]+)]\(([^)\s]+)\)""")) { m -> safeHref(m.groupValues[2])?.let { Inline.Link(it, parseInline(m.groupValues[1])) } },
    InlineRule(Regex("""(?:https?://|www\.)[^\s<>()]+[^\s<>().,;:!?'"]""", RegexOption.IGNORE_CASE)) { m ->
        safeHref(m.value)?.let { Inline.Link(it, listOf(Inline.Text(m.value))) }
    },
    InlineRule(Regex("""[\w.+-]+@[\w-]+\.[\w.-]*\w""")) { Inline.Link("mailto:${it.value}", listOf(Inline.Text(it.value))) },
    InlineRule(Regex("""\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__""")) { Inline.Strong(parseInline(it.groups[1]?.value ?: it.groupValues[2])) },
    InlineRule(Regex("""~~(?=\S)(.+?)~~""")) { Inline.Del(parseInline(it.groupValues[1])) },
    InlineRule(Regex("""\*(?=\S)([^*]+?)\*|(?<!\w)_(?=\S)([^_]+?)_(?!\w)""")) { Inline.Em(parseInline(it.groups[1]?.value ?: it.groupValues[2])) },
)

private fun merge(nodes: List<Inline>): List<Inline> {
    val out = mutableListOf<Inline>()
    for (n in nodes) {
        val prev = out.lastOrNull()
        if (n is Inline.Text && prev is Inline.Text) out[out.size - 1] = Inline.Text(prev.text + n.text) else out += n
    }
    return out
}

fun parseInline(text: String): List<Inline> {
    val out = mutableListOf<Inline>()
    var rest = text
    while (rest.isNotEmpty()) {
        var best: Pair<MatchResult, InlineRule>? = null
        for (rule in RULES) {
            val m = rule.re.find(rest) ?: continue
            if (best == null || m.range.first < best.first.range.first) best = m to rule
        }
        if (best == null) {
            out += Inline.Text(rest)
            break
        }
        val (m, rule) = best
        if (m.range.first > 0) out += Inline.Text(rest.substring(0, m.range.first))
        out += rule.make(m) ?: Inline.Text(m.value)
        rest = rest.substring(m.range.last + 1)
    }
    return merge(out)
}

private val CHECKBOX = Regex("""^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])]""")

/** Flips the checkbox on [line] (`- [ ]` ⇄ `- [x]`). */
fun toggleChecklistLine(src: String, line: Int): String {
    val lines = src.split("\n").toMutableList()
    val l = lines.getOrNull(line) ?: return src
    lines[line] = CHECKBOX.replace(l) { m -> "${m.groupValues[1]}[${if (m.groupValues[2] == " ") "x" else " "}]" }
    return lines.joinToString("\n")
}

/** The plain text of some Markdown, for one-line previews. */
fun plainText(nodes: List<Inline>): String = nodes.joinToString("") {
    when (it) {
        is Inline.Text -> it.text
        is Inline.Code -> it.text
        is Inline.Strong -> plainText(it.children)
        is Inline.Em -> plainText(it.children)
        is Inline.Del -> plainText(it.children)
        is Inline.Link -> plainText(it.children)
    }
}
