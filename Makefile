.PHONY: build_graphviz graphs clean

UID=$(shell id -u)
GID=$(shell id -g)

GRAPHVIZ_DOCKER_IMG=contract/graphviz:latest

build_graphviz:
	@docker build -t $(GRAPHVIZ_DOCKER_IMG) -f docker/graphviz.Dockerfile .

graphs:
	@docker run --rm --user $(UID):$(GID) -v $(PWD)/graphs:/data $(GRAPHVIZ_DOCKER_IMG)

clean:
	@rm -r graphs/img
